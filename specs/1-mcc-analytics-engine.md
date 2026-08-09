# Halo MCC Email → Analytics Conversion Service
## System Specification

---

# 1. Overview

## 1.1 Purpose

This system is a **serverless, event-driven ingestion and normalization service** that converts Halo: The Master Chief Collection (MCC) post-game summary screenshots (received via email) into structured, analytics-ready CSV datasets.

It automatically:

- Receives inbound emails
- Extracts attached scoreboard screenshots
- Uses OCR to extract player stats
- Detects team composition via color analysis
- Normalizes match results into structured rows
- Outputs a single CSV per match

---

# 2. Goals

## 2.1 Functional Goals

The system must:

1. Accept inbound emails containing one or more scoreboard screenshots.
2. Automatically extract structured player statistics.
3. Support:
   - Arbitrary team sizes (e.g., 1v3v2, 4v3, 3v3, etc.)
   - Free-for-all (FFA) matches
4. Detect team membership via background color.
5. Map team colors to official MCC names:
   - Red
   - Blue
   - Green
   - Orange
   - Gold
   - Purple
   - Brown
   - Pink
6. Derive win/loss status.
7. Output a single CSV per match.
8. Support debug mode to persist cropped scoreboard images.

---

# 3. High-Level Architecture

Inbound Email  
→ Amazon SES (Receipt Rule)  
→ S3 (raw email storage)  
→ SES Email Handler Lambda  
→ Preprocess Image Lambda  
→ CSV Output to S3  

---

# 4. Functional Requirements

## 4.1 Email Ingestion

- Emails must be received via Amazon SES.
- Emails must match configured recipient address.
- Emails must contain one or more image attachments.
- Non-image attachments must be ignored.

## 4.2 Image Preprocessing

Each screenshot must:

- Auto-rotate via EXIF metadata.
- Enforce landscape orientation.
- Apply sharpening filter.
- Use Rekognition DetectText to locate scoreboard region.
- Crop to scoreboard region.
- Fallback to full image if anchors not found.

## 4.3 OCR Extraction

- Use Textract AnalyzeDocument with TABLES.
- Extract table cells and words.
- Construct structured row/column representation.

## 4.4 Player Row Extraction

- Detect header row dynamically.
- Fallback to column order if header detection fails.
- Ignore non-player rows (e.g., totals or non-numeric rows).

## 4.5 Team Detection

- Sample average RGB background per row.
- Cluster rows by RGB distance.
- Support arbitrary team sizes.
- Detect FFA when only one color cluster exists.

## 4.6 Team Color Naming

Clusters must map consistently to:

Red, Blue, Green, Orange, Gold, Purple, Brown, Pink

Mapping must be resilient to brightness/saturation variation.

## 4.7 Win/Loss Derivation

Team Games:
- Winning team determined by top player row.
- Winning team rows: win=1, loss=0.
- Others: win=0, loss=1.

FFA:
- Top row: win=1.
- Others: win=0, loss=1.
- Team column empty.

## 4.8 CSV Output Format

Columns:

Team,Player,Score,Kills,Assists,Deaths,Win,Loss

All values quoted.

---

# 5. Debug Mode

When enabled:

- Cropped scoreboard PNG must be written to:
  matches/<matchId>/cropped/<filename>.png
- Structured JSON logs must include crop dimensions.

---

# 6. Logging Requirements

Logs must:

- Be JSON structured.
- Include: level, message, contextual metadata.
- Use CloudWatch-compatible levels:
  ERROR, WARN, INFO, DEBUG, TRACE.

---

# 7. Unit Testing

Must include TAP-based unit tests for processScoreboardImage covering:

- Two-team matches
- Three-team uneven matches
- Free-for-all
- Non-player row filtering
- Header fallback
- Win/loss correctness

---

# 8. Infrastructure Requirements

CDK must provision:

- Raw Email S3 bucket
- Attachments S3 bucket
- CSV Output S3 bucket
- Preprocess Image Lambda
- SES Email Handler Lambda
- SES ReceiptRuleSet
- IAM policies for Rekognition, Textract, S3, and Lambda invocation

---

# 9. Security Requirements

- All S3 buckets must block public access.
- Buckets must use encryption.
- SES must have explicit PutObject permission.
- Lambdas must follow least-privilege IAM.

---

# 10. System Classification

This system is:

> A serverless, event-driven ingestion and normalization service that converts unstructured image inputs into analytics-ready structured datasets.

It contains ETL characteristics but is not a traditional warehouse ETL pipeline.

---
