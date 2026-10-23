# Changelog

## [3.4.1](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.4.0...match-to-csv-v3.4.1) (2026-10-23)


### Bug Fixes

* **match-to-csv:** base OCR confidence checks on Textract word confidence ([#410](https://github.com/samlevin/mcc-stats-suite/issues/410)) ([4f8874f](https://github.com/samlevin/mcc-stats-suite/commit/4f8874f6228380dc8dc239e9e7e4308a04607d87))
* **match-to-csv:** strip clan tags that follow misread emblem text ([#404](https://github.com/samlevin/mcc-stats-suite/issues/404)) ([67fd87f](https://github.com/samlevin/mcc-stats-suite/commit/67fd87f4589a75203ce84b8ce988f88b63adc706)), closes [#403](https://github.com/samlevin/mcc-stats-suite/issues/403)

## [3.4.0](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.3.0...match-to-csv-v3.4.0) (2026-10-22)


### Features

* **match-to-csv:** add alarms, saved queries and the dashboard ([#402](https://github.com/samlevin/mcc-stats-suite/issues/402)) ([ef8b260](https://github.com/samlevin/mcc-stats-suite/commit/ef8b260c12605f2915d9561244315182dd6f93cd)), closes [#336](https://github.com/samlevin/mcc-stats-suite/issues/336)
* **match-to-csv:** emit stage events from process-email, extract-text and write-extracted-csv ([#401](https://github.com/samlevin/mcc-stats-suite/issues/401)) ([980ca5a](https://github.com/samlevin/mcc-stats-suite/commit/980ca5a2691d77eccec300965aa38743b4e6320b)), closes [#334](https://github.com/samlevin/mcc-stats-suite/issues/334)
* **match-to-csv:** emit stage events from write-gamertag-csvs ([#397](https://github.com/samlevin/mcc-stats-suite/issues/397)) ([f0a8742](https://github.com/samlevin/mcc-stats-suite/commit/f0a874210be01c0ab5ff3524408e6fa0e311c56a)), closes [#335](https://github.com/samlevin/mcc-stats-suite/issues/335)
* **match-to-csv:** measure Textract time and cell confidence in extract-text ([#356](https://github.com/samlevin/mcc-stats-suite/issues/356)) ([d6b52da](https://github.com/samlevin/mcc-stats-suite/commit/d6b52dab57b6dd176336a0cabe577e15f9904bc3)), closes [#341](https://github.com/samlevin/mcc-stats-suite/issues/341)
* **match-to-csv:** set logging levels and the metrics switch in the stack ([#387](https://github.com/samlevin/mcc-stats-suite/issues/387)) ([feeeb59](https://github.com/samlevin/mcc-stats-suite/commit/feeeb596873810f0fe5c856939f85203612ef047))


### Bug Fixes

* **match-to-csv:** flag split trailing digits after punctuation ([#395](https://github.com/samlevin/mcc-stats-suite/issues/395)) ([6b513b1](https://github.com/samlevin/mcc-stats-suite/commit/6b513b1aa0c1631646801fef957eaa3518892e3f))
* **match-to-csv:** grant ses:SendRawEmail to the gamertag CSV email Lambda ([#391](https://github.com/samlevin/mcc-stats-suite/issues/391)) ([54d2263](https://github.com/samlevin/mcc-stats-suite/commit/54d2263a05573ebf25a48d8136961ae0a203890e)), closes [#389](https://github.com/samlevin/mcc-stats-suite/issues/389)
* **match-to-csv:** stop copying Kills into Assists when the ASSISTS header is misread ([#394](https://github.com/samlevin/mcc-stats-suite/issues/394)) ([46660ac](https://github.com/samlevin/mcc-stats-suite/commit/46660ac88899521183f3c7cba64091627abfaddd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mcc/contracts bumped from 1.3.0 to 1.3.1
    * @mcc/recipients bumped from 1.1.2 to 1.1.3
    * @mcc/roster bumped from 1.1.3 to 1.1.4

## [3.3.0](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.2.1...match-to-csv-v3.3.0) (2026-10-22)


### Features

* **contracts:** add trace context and receivedAt to the contracts ([#337](https://github.com/samlevin/mcc-stats-suite/issues/337)) ([f5156a4](https://github.com/samlevin/mcc-stats-suite/commit/f5156a4b3086ff86941fe9f2c731b498b8cf0c8f)), closes [#328](https://github.com/samlevin/mcc-stats-suite/issues/328)
* **match-to-csv:** build and publish stage events ([#348](https://github.com/samlevin/mcc-stats-suite/issues/348)) ([2945a5a](https://github.com/samlevin/mcc-stats-suite/commit/2945a5ae2aa7faa3816cb84f38143eabc80c1e9a)), closes [#330](https://github.com/samlevin/mcc-stats-suite/issues/330)
* **match-to-csv:** create alarms only in prod ([#361](https://github.com/samlevin/mcc-stats-suite/issues/361)) ([cf3cc3c](https://github.com/samlevin/mcc-stats-suite/commit/cf3cc3c2eea1e33783419bf57ecd96c8854ea857)), closes [#359](https://github.com/samlevin/mcc-stats-suite/issues/359)
* **match-to-csv:** email each submission's gamertag CSVs to the recipient list ([#388](https://github.com/samlevin/mcc-stats-suite/issues/388)) ([67bcaa8](https://github.com/samlevin/mcc-stats-suite/commit/67bcaa81541c902fbdefe13e45cd818d95dd0d44))
* **match-to-csv:** end rejected submissions as succeeded ([#353](https://github.com/samlevin/mcc-stats-suite/issues/353)) ([bb8a7aa](https://github.com/samlevin/mcc-stats-suite/commit/bb8a7aa975dadd59bcbdc19bfa244209d6855174))
* **match-to-csv:** pass trace context through the workflows ([#352](https://github.com/samlevin/mcc-stats-suite/issues/352)) ([0e8c199](https://github.com/samlevin/mcc-stats-suite/commit/0e8c199c5f97cf4460d3fa2e727658622b717889)), closes [#331](https://github.com/samlevin/mcc-stats-suite/issues/331)
* **match-to-csv:** return the match date reply result from process-email ([#355](https://github.com/samlevin/mcc-stats-suite/issues/355)) ([b6d3a6a](https://github.com/samlevin/mcc-stats-suite/commit/b6d3a6a4d8b3cf9227fd13d84158963ab6a3426d)), closes [#340](https://github.com/samlevin/mcc-stats-suite/issues/340)


### Bug Fixes

* **match-to-csv:** keep log records queryable under the JSON log format ([#354](https://github.com/samlevin/mcc-stats-suite/issues/354)) ([4d0fd20](https://github.com/samlevin/mcc-stats-suite/commit/4d0fd209ed47c048c14363677184e79582a25e6c)), closes [#339](https://github.com/samlevin/mcc-stats-suite/issues/339)
* **match-to-csv:** process only allowlisted senders ([#351](https://github.com/samlevin/mcc-stats-suite/issues/351)) ([9565f46](https://github.com/samlevin/mcc-stats-suite/commit/9565f4649c6a4e375d57bd3bcf6f3d185fecb1c9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mcc/contracts bumped from 1.2.1 to 1.3.0
    * @mcc/recipients bumped from 1.1.1 to 1.1.2
    * @mcc/roster bumped from 1.1.2 to 1.1.3

## [3.2.1](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.2.0...match-to-csv-v3.2.1) (2026-10-19)


### Bug Fixes

* **cdk:** pin unset CDK feature flags to their current defaults ([#316](https://github.com/samlevin/mcc-stats-suite/issues/316)) ([6ec0dba](https://github.com/samlevin/mcc-stats-suite/commit/6ec0dba05b8bd93205c2563c0bab86fb904042e2)), closes [#281](https://github.com/samlevin/mcc-stats-suite/issues/281)

## [3.2.0](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.1.0...match-to-csv-v3.2.0) (2026-10-19)


### Features

* **cdk:** explain plan resources and changes ([#301](https://github.com/samlevin/mcc-stats-suite/issues/301)) ([5a1bc8c](https://github.com/samlevin/mcc-stats-suite/commit/5a1bc8ce85b2e03764bbdc26f17a0066b2e4af2b))

## [3.1.0](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.0.1...match-to-csv-v3.1.0) (2026-10-19)


### Features

* **scripts:** share CLI parsing and command shortcuts ([#288](https://github.com/samlevin/mcc-stats-suite/issues/288)) ([5e3df0f](https://github.com/samlevin/mcc-stats-suite/commit/5e3df0ff1497a0ec9995cd651aefcaf0303394d7))


### Bug Fixes

* **match-to-csv:** use the first valid email body date ([#286](https://github.com/samlevin/mcc-stats-suite/issues/286)) ([4b9efbd](https://github.com/samlevin/mcc-stats-suite/commit/4b9efbd3527751494ef0b73e1ba2aae3eb64b6c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mcc/contracts bumped from 1.2.0 to 1.2.1
    * @mcc/roster bumped from 1.1.1 to 1.1.2

## [3.0.1](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v3.0.0...match-to-csv-v3.0.1) (2026-10-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mcc/contracts bumped from 1.1.0 to 1.2.0
    * @mcc/roster bumped from 1.1.0 to 1.1.1

## [3.0.0](https://github.com/samlevin/mcc-stats-suite/compare/match-to-csv-v2.0.0...match-to-csv-v3.0.0) (2026-10-18)


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
