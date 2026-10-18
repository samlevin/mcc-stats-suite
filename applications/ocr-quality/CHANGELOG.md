# Changelog

## [1.1.0](https://github.com/samlevin/mcc-stats-suite/compare/ocr-quality-v1.0.0...ocr-quality-v1.1.0) (2026-10-18)


### Features

* **repository:** use GitHub Packages for shared libraries ([#28](https://github.com/samlevin/mcc-stats-suite/issues/28)) ([9463f49](https://github.com/samlevin/mcc-stats-suite/commit/9463f497b536d274e0d1eadd68f0bd26a733d495))


### Bug Fixes

* **cdk-config:** isolate local deployments from shared dev stacks ([#41](https://github.com/samlevin/mcc-stats-suite/issues/41)) ([de0eb1a](https://github.com/samlevin/mcc-stats-suite/commit/de0eb1ab7a0101b3136d7a71c58800bca4be4d93))
* **match-to-csv:** retain SES receipt rules before moving them to OpenTofu ([#49](https://github.com/samlevin/mcc-stats-suite/issues/49)) ([65e4640](https://github.com/samlevin/mcc-stats-suite/commit/65e4640f7223fe824f6e5336415887c0f5deb1d3))


### Performance Improvements

* **ci:** run affected checks concurrently with isolated caching ([#13](https://github.com/samlevin/mcc-stats-suite/issues/13)) ([22861a6](https://github.com/samlevin/mcc-stats-suite/commit/22861a62a622460fea1d18f6f80e31e9a5cb976b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mcc/cdk-config bumped from 1.0.0 to 2.0.0
