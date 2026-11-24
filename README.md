# SISO's T3 Code: patches on upstream nightlies

Shaan, 24 Nov 2026: "Remember we have a way of SISO forking it so we can still keep the changes in the future. How can we make sure we're keeping T3's upgrades though?"

The T3 Code that SISO runs is an upstream nightly from pingdotgg/t3code plus a short stack of SISO patches. Each patch is a branch on this fork, sisodias/t3code. This branch, `siso/tools`, holds the stack's definition and the command that rebuilds it. It shares no history with upstream.

| Patch | Branch | Base | Upstream |
| --- | --- | --- | --- |
| no-queue: messages join the running turn | `siso/no-queue` | nightly | draft in `upstream-pr/no-queue.md` |
| updates: T3's update offer starts a SISO rebuild | `siso/updates` | nightly | SISO-only, never upstream |
| glibc-ceiling: a build made on this laptop may use its own glibc | `siso/linux-glibc-ceiling` | nightly | draft in `upstream-pr/linux-glibc-ceiling.md` |
| video-backgrounds | `feat/theme-video-backgrounds` (#1) | nightly | draft is the body of #1 |
| background-page (optional until it is on the fork) | `feat/theme-background-page` (#2) | video-backgrounds | draft is the body of #2 |

`stack.json` gives the order, each patch's tests, and the checks run on the combined build.

## The update command

`bin/t3-siso-update run` (installed as `~/.local/bin/t3-siso-update`):

1. Fetches upstream's nightly tags and takes the newest one.
2. Drops any patch whose upstream PR is merged into that nightly. Rebases every other patch onto the nightly, or onto the patch it stacks on. A patch whose commits are all upstream already rebases to nothing and is dropped.
3. If a patch no longer applies, stops. The current build stays, and the message names the patch, the commit and the conflicting files.
4. Merges the patches onto the nightly. That merge is the build commit, and it is reproducible: the same nightly and patch tips always give the same commit.
5. Runs each patch's tests and the build checks there. Any failure names the patch and keeps the current build.
6. Builds the arm64 AppImage into `~/.local/share/t3code/siso-<version>-<commit>/`, with `build.json` beside it. The app's update feed points at upstream, so T3 keeps offering new nightlies. The build's glibc ceiling is this machine's glibc (`getconf GNU_LIBC_VERSION`), because node-pty compiles against it.
7. Pushes the rebased patch branches with `--force-with-lease`, plus `siso/build` and a `siso/<version>-<commit>` tag. Fast-forwards the fork's `main` to the nightly.
8. Arms `bin/t3-switch-when-idle --to <AppImage>`. That waits until T3 has no turn running, swaps the app, checks it is healthy, and rolls back to the previous build if not.

Logs, `state.json` and `history.log` are in `~/.local/state/t3-siso-update/`. Results and failures go to `notify_thread` in `stack.json`; a run's `--wake THREAD` overrides it.

Measured files, such as `agentContextBudget.json`, merge with `bin/siso-sum-json`: upstream's new value plus each patch's own growth. The build's budget test then checks the sum.

## What starts it: T3 offering an update

Shaan's rule is "Nothing runs on a timer". The `updates` patch hooks T3's own update check, which runs at startup and every 4 hours inside T3; SISO adds no timer.

- When that check finds a newer upstream nightly, T3 runs `t3-siso-update trigger --offered <version>`, which starts `run` as the transient systemd user unit `t3-siso-update`.
- "Download update" in T3 never fetches the stock build. It starts the same rebuild and says so.
- That makes upstream publishing a nightly, as seen by T3's own check, the event. Without this patch, the stock updater would replace the AppImage with an unpatched build.

A run is skipped when the same nightly and patch tips have already been built, or have already failed. `run --force` overrides that.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | built and armed, or nothing to do |
| 10 | a patch no longer applies |
| 11 | patches conflict with each other |
| 12 | a test failed |
| 13 | the build failed |
| 14 | setup or git failed |
| 15 | the switch was not armed |

## Setup on a machine

```sh
git clone --filter=blob:none https://github.com/sisodias/t3code.git && cd t3code
git remote add upstream https://github.com/pingdotgg/t3code.git
git worktree add ../siso-tools siso/tools
git worktree add --detach ../siso-build                                   # the command's own lane; it owns it
ln -s "$PWD/../siso-tools/bin/t3-siso-update" ~/.local/bin/t3-siso-update
```

Edit `lane` in `stack.json` if the build lane lives elsewhere.

On Arch, also `sudo pacman -S libxcrypt-compat`: upstream's AppImage build packages a `.deb` too, with a bundled fpm whose Ruby needs `libcrypt.so.1`. The command checks for it before it starts.

## Adding or removing a patch

- To add one: push its branch to the fork, then add an entry to `stack.json` with `name`, `branch`, `base` (`upstream` or an earlier patch's name) and `tests`.
- Once upstream takes a patch, the command drops it on its own. Then delete its entry here.
