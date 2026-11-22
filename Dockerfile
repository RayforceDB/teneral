# The same Bun the project is developed with.
FROM oven/bun:1.4.4
# The repo is mounted here at run time; the image holds no project files.
WORKDIR /teneral
# git for the worktrees; procps because the body's tests look for processes with pgrep and pkill.
# For organs (immune/organs.ts), the release archives of native dependencies the agent adopts: curl,
# tar and gzip to fetch one and look into it, and a C toolchain to build such a dependency from its
# source when the agent works on a patch for it: clang with its sanitizer runtimes, and make.
# openssh-client for ssh-keygen alone: the individual's signing key and its signatures (species/offerkey.ts).
# gh for the agent's own work on GitHub: pull requests, issues, reviews (below).
# chromium, with one family of fonts so that a page has letters, is the agent's own browser: for the
# pages a person would open by hand, such as signing in to an account its owner made for it. It has
# no window, and is started with --no-sandbox: its own sandbox needs privileges this container is
# run without, and the container is what confines it.
# ripgrep, fd, jq and universal-ctags are for reading a codebase without reading it whole: the first
# three are the agent's to call, and ctags, with ast-grep below, answers its `code` command
# (body/code.ts). clangd answers it for C where a name has to be resolved: who uses a function, what
# a use refers to, what a compiler says of a file (body/code-clangd.ts). unzip opens the ast-grep archive.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
    curl tar gzip clang libclang-rt-dev libc6-dev make openssh-client gh \
    chromium fonts-liberation \
    ripgrep fd-find jq universal-ctags clangd unzip \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# ast-grep searches code by its shape, with a tree-sitter parser for each language. It is not in the
# distribution, so its release archive is fetched and kept only with the pinned hash of its build
# for this machine.
ARG AST_GREP=0.51.3
RUN case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64 sum=22803eb0c5bf83164fb7fd76d4721d355ecf0c8466ef47342c1ec7d80897ca47 ;; \
      arm64) arch=aarch64 sum=5b44fd68e78744934b359b07badce347d4197ed50b341d50f1f99d056ecedb08 ;; \
      *) echo "no ast-grep build is pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/ast-grep.zip "https://github.com/ast-grep/ast-grep/releases/download/$AST_GREP/app-$arch-unknown-linux-gnu.zip" \
 && echo "$sum  /tmp/ast-grep.zip" | sha256sum -c - \
 && unzip -q /tmp/ast-grep.zip ast-grep -d /usr/local/bin && chmod 755 /usr/local/bin/ast-grep \
 && rm /tmp/ast-grep.zip

# Rayfall is not a language ast-grep carries. Its grammar is built here from one pinned commit of
# its source, and the configuration beside it tells ast-grep where the grammar is. body/code-backends.ts
# names this configuration when the question is about a Rayfall file.
ARG RAYFALL_GRAMMAR=230b850d422b4345911ca38b34028474b8bb7fe8
RUN git clone -q https://github.com/vbmithr/tree-sitter-rayfall.git /tmp/rayfall \
 && git -C /tmp/rayfall -c advice.detachedHead=false checkout -q "$RAYFALL_GRAMMAR" \
 && mkdir -p /usr/local/lib/teneral \
 && clang -shared -fPIC -O2 -I /tmp/rayfall/src -o /usr/local/lib/teneral/rayfall.so /tmp/rayfall/src/parser.c \
 && rm -rf /tmp/rayfall \
 && printf '%s\n' 'ruleDirs: []' 'customLanguages:' '  rayfall:' \
    '    libraryPath: /usr/local/lib/teneral/rayfall.so' '    extensions: [rfl]' '    expandoChar: _' \
    > /usr/local/lib/teneral/sgconfig.yml

# The agent's git and gh sign in to github.com with the token its owner stored (./one offer token):
# git asks the first program below, and gh is started by the second. With no token stored, or in a
# run that is given no auth directory (the gates), both stay silent. The token is read from its file
# at each use; it is in no configuration and no image layer.
RUN printf '%s\n' '#!/bin/sh' \
    '[ "$1" = get ] || exit 0' \
    'f="${TENERAL_AUTH:-}/github-token"' \
    '[ -s "$f" ] || exit 0' \
    'printf "username=x-access-token\npassword=%s\n" "$(tr -d "\r\n" < "$f")"' \
    > /usr/local/bin/teneral-github-credential \
 && printf '%s\n' '#!/bin/sh' \
    'f="${TENERAL_AUTH:-}/github-token"' \
    'if [ -z "${GH_TOKEN:-}" ] && [ -s "$f" ]; then' \
    '  GH_TOKEN="$(tr -d "\r\n" < "$f")"; export GH_TOKEN' \
    'fi' \
    'exec /usr/bin/gh "$@"' \
    > /usr/local/bin/gh \
 && chmod 755 /usr/local/bin/teneral-github-credential /usr/local/bin/gh

# Run as the owner's uid, so files written to the mounted repo stay theirs.
ARG UID=1000
ARG GID=1000
# The base image's own user would otherwise share that uid and give it its name. Its home goes too.
RUN userdel bun && rm -rf /home/bun \
 && groupadd --non-unique --gid "$GID" teneral \
 && useradd --non-unique --uid "$UID" --gid "$GID" --create-home --home-dir /home/teneral teneral
USER teneral
ENV HOME=/home/teneral
RUN git config --global --add safe.directory '*' \
 && git config --global user.name teneral \
 && git config --global user.email teneral@localhost \
 && git config --global credential.https://github.com.helper /usr/local/bin/teneral-github-credential

# The launcher, from the owner's checkout. It starts the stem of whichever generation is current.
CMD ["bun", "stem/launcher.ts"]
