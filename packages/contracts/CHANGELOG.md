# Changelog

## [1.3.1](https://github.com/samlevin/mcc-stats-suite/compare/contracts-v1.3.0...contracts-v1.3.1) (2026-10-22)


### Bug Fixes

* **match-to-csv:** flag split trailing digits after punctuation ([#395](https://github.com/samlevin/mcc-stats-suite/issues/395)) ([6b513b1](https://github.com/samlevin/mcc-stats-suite/commit/6b513b1aa0c1631646801fef957eaa3518892e3f))
* **match-to-csv:** stop copying Kills into Assists when the ASSISTS header is misread ([#394](https://github.com/samlevin/mcc-stats-suite/issues/394)) ([46660ac](https://github.com/samlevin/mcc-stats-suite/commit/46660ac88899521183f3c7cba64091627abfaddd))

## [1.3.0](https://github.com/samlevin/mcc-stats-suite/compare/contracts-v1.2.1...contracts-v1.3.0) (2026-10-22)


### Features

* **contracts:** add trace context and receivedAt to the contracts ([#337](https://github.com/samlevin/mcc-stats-suite/issues/337)) ([f5156a4](https://github.com/samlevin/mcc-stats-suite/commit/f5156a4b3086ff86941fe9f2c731b498b8cf0c8f)), closes [#328](https://github.com/samlevin/mcc-stats-suite/issues/328)
* **match-to-csv:** email each submission's gamertag CSVs to the recipient list ([#388](https://github.com/samlevin/mcc-stats-suite/issues/388)) ([67bcaa8](https://github.com/samlevin/mcc-stats-suite/commit/67bcaa81541c902fbdefe13e45cd818d95dd0d44))

## [1.2.1](https://github.com/samlevin/mcc-stats-suite/compare/contracts-v1.2.0...contracts-v1.2.1) (2026-10-19)


### Bug Fixes

* **match-to-csv:** use the first valid email body date ([#286](https://github.com/samlevin/mcc-stats-suite/issues/286)) ([4b9efbd](https://github.com/samlevin/mcc-stats-suite/commit/4b9efbd3527751494ef0b73e1ba2aae3eb64b6c7))

## [1.2.0](https://github.com/samlevin/mcc-stats-suite/compare/contracts-v1.1.0...contracts-v1.2.0) (2026-10-18)


### Features

* **recipients:** keep the CSV recipient list in DynamoDB with an operator script ([#276](https://github.com/samlevin/mcc-stats-suite/issues/276)) ([760ff41](https://github.com/samlevin/mcc-stats-suite/commit/760ff41aa4e588bb3c4d47b207213070aff1810b)), closes [#272](https://github.com/samlevin/mcc-stats-suite/issues/272)

## [1.1.0](https://github.com/samlevin/mcc-stats-suite/compare/contracts-v1.0.0...contracts-v1.1.0) (2026-10-18)


### Features

* **contracts:** export roster and resolution contracts ([#210](https://github.com/samlevin/mcc-stats-suite/issues/210)) ([15cef5b](https://github.com/samlevin/mcc-stats-suite/commit/15cef5bb675993b2f8b17f9c735b90cb3d84f559)), closes [#194](https://github.com/samlevin/mcc-stats-suite/issues/194)
* **infrastructure:** configure the email alias like the email domain ([#137](https://github.com/samlevin/mcc-stats-suite/issues/137)) ([3d84c18](https://github.com/samlevin/mcc-stats-suite/commit/3d84c18163d4d2f9fdd02f4d55604827e1d3d4f4))
* **match-to-csv:** reject email that fails SES verdicts or the sender allowlist ([#99](https://github.com/samlevin/mcc-stats-suite/issues/99)) ([fedfa26](https://github.com/samlevin/mcc-stats-suite/commit/fedfa266cb9793fae736576d94f1f6add938d839)), closes [#90](https://github.com/samlevin/mcc-stats-suite/issues/90)
* **match-to-csv:** reject emails without a match date and reply with an error ([#213](https://github.com/samlevin/mcc-stats-suite/issues/213)) ([02da57f](https://github.com/samlevin/mcc-stats-suite/commit/02da57fdc7c738f2905d8746aafe737f371f0c40))
* **match-to-csv:** write legacy-spreadsheet CSVs per gamertag ([#265](https://github.com/samlevin/mcc-stats-suite/issues/265)) ([db0ab50](https://github.com/samlevin/mcc-stats-suite/commit/db0ab50bb46398b4f5c4936d027b6deae12c0474)), closes [#202](https://github.com/samlevin/mcc-stats-suite/issues/202)
* preserve screenshot OCR provenance ([f6c0ab0](https://github.com/samlevin/mcc-stats-suite/commit/f6c0ab069bfa247779f1f5205630c0e852109697))
* **repository:** use GitHub Packages for shared libraries ([#28](https://github.com/samlevin/mcc-stats-suite/issues/28)) ([9463f49](https://github.com/samlevin/mcc-stats-suite/commit/9463f497b536d274e0d1eadd68f0bd26a733d495))
* **roster:** maintain the roster with a local operator script ([#260](https://github.com/samlevin/mcc-stats-suite/issues/260)) ([06c3177](https://github.com/samlevin/mcc-stats-suite/commit/06c3177098d9fa22ece29ee105fe3c4ec1436899)), closes [#198](https://github.com/samlevin/mcc-stats-suite/issues/198)


### Bug Fixes

* **match-to-csv:** flag possibly misread gamertags for review ([#169](https://github.com/samlevin/mcc-stats-suite/issues/169)) ([28094e6](https://github.com/samlevin/mcc-stats-suite/commit/28094e661163403cfcf7d9c4eae8f687ebcbf1c0)), closes [#161](https://github.com/samlevin/mcc-stats-suite/issues/161)


### Performance Improvements

* **ci:** run affected checks concurrently with isolated caching ([#13](https://github.com/samlevin/mcc-stats-suite/issues/13)) ([22861a6](https://github.com/samlevin/mcc-stats-suite/commit/22861a62a622460fea1d18f6f80e31e9a5cb976b))
