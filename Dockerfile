# The same Bun the project is developed with.
FROM oven/bun:1.4.4
# The repo is mounted here at run time; the image holds no project files.
WORKDIR /teneral
# git for the worktrees; procps because the body's tests look for processes with pgrep and pkill.
# For organs (kernel/organs.ts), the release archives of native dependencies the agent adopts: curl,
# tar and gzip to fetch one and look into it, and a C toolchain to build such a dependency from its
# source when the agent works on a patch for it: clang with its sanitizer runtimes, and make.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
    curl tar gzip clang libclang-rt-dev libc6-dev make \
 && rm -rf /var/lib/apt/lists/*

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
 && git config --global user.email teneral@localhost

CMD ["bun", "kernel/main.ts"]
