# Third-Party Notices

TransLay source code in this repository is licensed under the Apache License 2.0
unless a file says otherwise.

Third-party packages keep their own licenses. This notice highlights dependency
licenses that are especially relevant for redistribution and review. It is not a
complete SBOM; use `package-lock.json` and package metadata for the full
transitive dependency list.

## Blue Oak Model License 1.0.0

The current dependency tree includes the following transitive packages licensed
under the Blue Oak Model License 1.0.0 (`BlueOak-1.0.0`):

| Package | Version | Path in dependency tree |
|---|---:|---|
| `jackspeak` | `3.4.3` | `googleapis -> googleapis-common -> gaxios -> rimraf -> glob -> jackspeak` |
| `minipass` | `7.1.3` | `googleapis -> googleapis-common -> gaxios -> rimraf -> glob -> minipass` |
| `package-json-from-dist` | `1.0.1` | `googleapis -> googleapis-common -> gaxios -> rimraf -> glob -> package-json-from-dist` |
| `path-scurry` | `1.11.1` | `googleapis -> googleapis-common -> gaxios -> rimraf -> glob -> path-scurry` |

License text:

- Blue Oak Council: <https://blueoakcouncil.org/license/1.0.0>
- SPDX: <https://spdx.org/licenses/BlueOak-1.0.0.html>

BlueOak-1.0.0 is a permissive software license. It does not require this project
to be relicensed under BlueOak-1.0.0. When redistributing packages under this
license, provide the license text or a link to the license.

## Other Notable Runtime Dependencies

The following direct runtime dependencies are commonly reviewed during
self-hosting or redistribution:

| Package | License | Notes |
|---|---|---|
| `googleapis` | Apache-2.0 | Google Workspace™ API client used by the worker. |
| `google-auth-library` | Apache-2.0 | Google OAuth and service-account authentication. |
| `express` | MIT | HTTP server framework for control-plane and worker services. |
| `pg` | MIT | PostgreSQL client. |
| `ioredis` | MIT | Redis client. |

## Development Dependencies

The repository also uses development/build dependencies such as `typescript`,
`tsx`, and `@types/*` packages. Their exact versions and license metadata are
recorded in `package-lock.json`.

## Dependency License Policy

New dependencies should use one of the following approved permissive licenses
unless maintainers explicitly approve an exception:

- Apache-2.0
- MIT
- BSD-style licenses
- ISC
- BlueOak-1.0.0
