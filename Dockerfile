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
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
    curl tar gzip clang libclang-rt-dev libc6-dev make openssh-client gh \
    chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

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
