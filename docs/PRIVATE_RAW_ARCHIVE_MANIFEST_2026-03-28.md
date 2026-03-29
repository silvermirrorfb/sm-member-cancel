# Private Raw Archive Manifest - 2026-03-28

## Purpose

This document tells future operators where the full raw handoff export lives without placing the raw export itself into `main`.

## Private Archive Location

- archival branch: `archive/raw-export-2026-03-28`
- archive file path on that branch: `cloud-archive/ai_takeover_export_2026-03-28.tar.gz`

## What The Raw Archive Contains

- the local export folder `ai_takeover_export_2026-03-28/`
- the duplicate repo snapshot used for point-in-time takeover
- git metadata exports captured at export time
- raw transcripts and operational logs that were intentionally not committed to `main`
- raw dry-run matrices and delete manifests

## Why It Is Separate

The raw archive contains sensitive operational details and duplicate snapshot material that would unnecessarily bloat or contaminate normal repo history.

Keeping it on a dedicated archival branch provides cloud safekeeping while leaving `main` readable and safer for normal engineering work.

## Important Rule

Do not merge the archival branch into `main`.

Treat it as a private evidence/archive branch only.
