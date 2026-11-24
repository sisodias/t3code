Title: build(linux): let a build for one newer machine set its own glibc ceiling

## Problem

`scripts/linux-glibc.ts` fails the AppImage and deb builds when any packaged ELF needs glibc newer than 2.39, the version on the Ubuntu 24.04 release builders. That is right for releases. On a newer distro, a local build compiles node-pty against the local glibc, so the check always fails:

```
Cannot validate glibc compatibility of …/node-pty/build/Release/pty.node: requires GLIBC_2.42, exceeding build ceiling 2.39
```

Anyone building T3 Code for their own Arch or Fedora machine has to edit the script.

## Change

- `T3CODE_LINUX_GLIBC_CEILING` raises the ceiling for one build, for example to the builder's own `getconf GNU_LIBC_VERSION`. That build then runs on that glibc and newer only.
- Release builds leave it unset and keep 2.39.
- A value that is not a version, such as `newest`, fails the build instead of being ignored.

## Verification

`scripts/linux-glibc.test.ts` adds "lets a build for one newer machine raise the ceiling to that machine's glibc": a `pty.node` needing 2.42 fails at the default 2.39, passes at 2.43, fails at 2.41, and `newest` fails with the variable's name. The test fails on the nightly and passes with this change.

SISO builds its arm64 AppImage on Arch Linux (glibc 2.43) with the ceiling set to the host's glibc.
