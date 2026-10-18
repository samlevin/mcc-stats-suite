# Changelog

## [2.0.0](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v1.0.0...match-to-csv-v2.0.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **infrastructure:** @samlevin/cdk-config drops DeploymentConfig.ingressEnabled and rejects prod as an ephemeral name. match-to-csv needs the foundation SSM parameters /mcc/<env>/match-to-csv/receipt-rule-set-name and email-domain and no longer reads MCC_EMAIL_DOMAIN.

### Features

* add OCR replay and run comparison ([b2e684a](https://github.com/samlevin/mcc-stats-suite/commit/b2e684a692b3d54b25fefb4f1b2d83cf045a129d))
* **infrastructure:** configure the email alias like the email domain ([#137](https://github.com/samlevin/mcc-stats-suite/issues/137)) ([3d84c18](https://github.com/samlevin/mcc-stats-suite/commit/3d84c18163d4d2f9fdd02f4d55604827e1d3d4f4))
* **match-to-csv:** add the player match status to the CSV ([#264](https://github.com/samlevin/mcc-stats-suite/issues/264)) ([d484654](https://github.com/samlevin/mcc-stats-suite/commit/d4846545fde29c47df8d23a77fc6874c30cad8a0)), closes [#201](https://github.com/samlevin/mcc-stats-suite/issues/201)
* **match-to-csv:** alarm on workflow failures, dead letters, and zero-row extractions ([#98](https://github.com/samlevin/mcc-stats-suite/issues/98)) ([4c76ad0](https://github.com/samlevin/mcc-stats-suite/commit/4c76ad07c00445c1f1a11bd8f96589c3f0980ac9)), closes [#89](https://github.com/samlevin/mcc-stats-suite/issues/89)
* **match-to-csv:** read the roster in extract-text before Textract ([#261](https://github.com/samlevin/mcc-stats-suite/issues/261)) ([fbbc958](https://github.com/samlevin/mcc-stats-suite/commit/fbbc9583831d1ee8e8815f76a618da800c9b212d)), closes [#199](https://github.com/samlevin/mcc-stats-suite/issues/199)
* **match-to-csv:** reject email that fails SES verdicts or the sender allowlist ([#99](https://github.com/samlevin/mcc-stats-suite/issues/99)) ([fedfa26](https://github.com/samlevin/mcc-stats-suite/commit/fedfa266cb9793fae736576d94f1f6add938d839)), closes [#90](https://github.com/samlevin/mcc-stats-suite/issues/90)
* **match-to-csv:** reject emails without a match date and reply with an error ([#213](https://github.com/samlevin/mcc-stats-suite/issues/213)) ([02da57f](https://github.com/samlevin/mcc-stats-suite/commit/02da57fdc7c738f2905d8746aafe737f371f0c40))
* **match-to-csv:** resolve player names against the roster ([#262](https://github.com/samlevin/mcc-stats-suite/issues/262)) ([7043f05](https://github.com/samlevin/mcc-stats-suite/commit/7043f05ec7f017920337fb37694327ad447af5e8)), closes [#200](https://github.com/samlevin/mcc-stats-suite/issues/200)
* **match-to-csv:** support only two-team scoreboards in the parser ([#190](https://github.com/samlevin/mcc-stats-suite/issues/190)) ([0e6ff69](https://github.com/samlevin/mcc-stats-suite/commit/0e6ff691ee8362f46d2b280cc378c753127ff125)), closes [#160](https://github.com/samlevin/mcc-stats-suite/issues/160)
* **match-to-csv:** write legacy-spreadsheet CSVs per gamertag ([#265](https://github.com/samlevin/mcc-stats-suite/issues/265)) ([db0ab50](https://github.com/samlevin/mcc-stats-suite/commit/db0ab50bb46398b4f5c4936d027b6deae12c0474)), closes [#202](https://github.com/samlevin/mcc-stats-suite/issues/202)
* preserve screenshot OCR provenance ([f6c0ab0](https://github.com/samlevin/mcc-stats-suite/commit/f6c0ab069bfa247779f1f5205630c0e852109697))
* **repository:** use GitHub Packages for shared libraries ([#28](https://github.com/samlevin/mcc-stats-suite/issues/28)) ([9463f49](https://github.com/samlevin/mcc-stats-suite/commit/9463f497b536d274e0d1eadd68f0bd26a733d495))
* route email to ephemeral match stacks ([8c16008](https://github.com/samlevin/mcc-stats-suite/commit/8c16008d523bb641083b048a47fdce6d4baf6db3))


### Bug Fixes

* **cdk-config:** isolate local deployments from shared dev stacks ([#41](https://github.com/samlevin/mcc-stats-suite/issues/41)) ([de0eb1a](https://github.com/samlevin/mcc-stats-suite/commit/de0eb1ab7a0101b3136d7a71c58800bca4be4d93))
* **cdk-config:** separate ephemeral deployment namespace ([#61](https://github.com/samlevin/mcc-stats-suite/issues/61)) ([c5add47](https://github.com/samlevin/mcc-stats-suite/commit/c5add47fcc50cc792c114a57745d092bc9ab86c5))
* **match-to-csv:** cluster team colors from player rows only ([#96](https://github.com/samlevin/mcc-stats-suite/issues/96)) ([a45e77a](https://github.com/samlevin/mcc-stats-suite/commit/a45e77a748be866e43d17779c84e0b949c5c4275)), closes [#88](https://github.com/samlevin/mcc-stats-suite/issues/88)
* **match-to-csv:** flag possibly misread gamertags for review ([#169](https://github.com/samlevin/mcc-stats-suite/issues/169)) ([28094e6](https://github.com/samlevin/mcc-stats-suite/commit/28094e661163403cfcf7d9c4eae8f687ebcbf1c0)), closes [#161](https://github.com/samlevin/mcc-stats-suite/issues/161)
* **match-to-csv:** limit images to Textract's 10 MB synchronous limit ([#100](https://github.com/samlevin/mcc-stats-suite/issues/100)) ([6519cf9](https://github.com/samlevin/mcc-stats-suite/commit/6519cf9cd0bc9167ebb7a02787bf8d5306c75236)), closes [#92](https://github.com/samlevin/mcc-stats-suite/issues/92)
* **match-to-csv:** manage log retention and ephemeral cleanup ([#80](https://github.com/samlevin/mcc-stats-suite/issues/80)) ([420b658](https://github.com/samlevin/mcc-stats-suite/commit/420b6588125ea74eecfc694cfb41f242827016ab))
* **match-to-csv:** retain SES receipt rules before moving them to OpenTofu ([#49](https://github.com/samlevin/mcc-stats-suite/issues/49)) ([65e4640](https://github.com/samlevin/mcc-stats-suite/commit/65e4640f7223fe824f6e5336415887c0f5deb1d3))
* **match-to-csv:** validate the parser against real Halo 3 two-team captures ([#162](https://github.com/samlevin/mcc-stats-suite/issues/162)) ([1d29f9d](https://github.com/samlevin/mcc-stats-suite/commit/1d29f9d64e46f1695832c2ec8cac2a14fd2720ef))


### Performance Improvements

* **ci:** run affected checks concurrently with isolated caching ([#13](https://github.com/samlevin/mcc-stats-suite/issues/13)) ([22861a6](https://github.com/samlevin/mcc-stats-suite/commit/22861a62a622460fea1d18f6f80e31e9a5cb976b))


### Code Refactoring

* **infrastructure:** move the SES receipt rule set into the foundation ([#56](https://github.com/samlevin/mcc-stats-suite/issues/56)) ([5c41f71](https://github.com/samlevin/mcc-stats-suite/commit/5c41f71a1534476d0a9cf9bf18580f15b843bce0)), closes [#45](https://github.com/samlevin/mcc-stats-suite/issues/45)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mcc/cdk-config bumped from 1.0.0 to 2.0.0
    * @mcc/contracts bumped from 1.0.0 to 1.1.0
    * @mcc/roster bumped from 1.0.0 to 1.1.0
