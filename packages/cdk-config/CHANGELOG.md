# Changelog

## [2.0.0](https://github.com/samlevin/mcc-stats-suite/compare/cdk-config-v1.0.0...cdk-config-v2.0.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **infrastructure:** @samlevin/cdk-config drops DeploymentConfig.ingressEnabled and rejects prod as an ephemeral name. match-to-csv needs the foundation SSM parameters /mcc/<env>/match-to-csv/receipt-rule-set-name and email-domain and no longer reads MCC_EMAIL_DOMAIN.

### Features

* **infrastructure:** deploy the local CDK bootstrap from an OpenTofu dev root ([#255](https://github.com/samlevin/mcc-stats-suite/issues/255)) ([2b102ab](https://github.com/samlevin/mcc-stats-suite/commit/2b102ab3a2b61f9f31acf37af688e93089f12290)), closes [#251](https://github.com/samlevin/mcc-stats-suite/issues/251)
* **repository:** use GitHub Packages for shared libraries ([#28](https://github.com/samlevin/mcc-stats-suite/issues/28)) ([9463f49](https://github.com/samlevin/mcc-stats-suite/commit/9463f497b536d274e0d1eadd68f0bd26a733d495))


### Bug Fixes

* **cdk-config:** isolate local deployments from shared dev stacks ([#41](https://github.com/samlevin/mcc-stats-suite/issues/41)) ([de0eb1a](https://github.com/samlevin/mcc-stats-suite/commit/de0eb1ab7a0101b3136d7a71c58800bca4be4d93))
* **cdk-config:** separate ephemeral deployment namespace ([#61](https://github.com/samlevin/mcc-stats-suite/issues/61)) ([c5add47](https://github.com/samlevin/mcc-stats-suite/commit/c5add47fcc50cc792c114a57745d092bc9ab86c5))
* **match-to-csv:** retain SES receipt rules before moving them to OpenTofu ([#49](https://github.com/samlevin/mcc-stats-suite/issues/49)) ([65e4640](https://github.com/samlevin/mcc-stats-suite/commit/65e4640f7223fe824f6e5336415887c0f5deb1d3))


### Performance Improvements

* **ci:** run affected checks concurrently with isolated caching ([#13](https://github.com/samlevin/mcc-stats-suite/issues/13)) ([22861a6](https://github.com/samlevin/mcc-stats-suite/commit/22861a62a622460fea1d18f6f80e31e9a5cb976b))


### Code Refactoring

* **infrastructure:** move the SES receipt rule set into the foundation ([#56](https://github.com/samlevin/mcc-stats-suite/issues/56)) ([5c41f71](https://github.com/samlevin/mcc-stats-suite/commit/5c41f71a1534476d0a9cf9bf18580f15b843bce0)), closes [#45](https://github.com/samlevin/mcc-stats-suite/issues/45)
