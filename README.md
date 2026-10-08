# SISSO-Sage

[English](README.md) | [简体中文](README.zh-CN.md)

SISSO-Sage helps an AI assistant inspect a completed SISSO run and identify
several scientifically defensible candidate formulas. You do not need to learn
its commands or scoring rules.

## Use it

1. Download this repository:

   ```bash
   git clone https://github.com/chen121760/SISSO-Sage.git
   ```

2. Put your completed SISSO output and feature-extraction code somewhere the AI
   can read. A simple layout is:

   ```text
   my-research/
   ├── SISSO-Sage/
   ├── sisso-run/
   │   ├── train.dat
   │   ├── verify.dat              # optional
   │   ├── Models/
   │   └── SIS_subspaces/
   └── feature-extraction/
       └── your feature scripts
   ```

3. Open the folder with your AI coding assistant and ask:

   > Use SISSO-Sage to analyze `sisso-run`. The feature-extraction code is in
   > `feature-extraction`.

The AI assistant will run the necessary commands, inspect the feature definitions
and source code when needed, and ask you when a feature meaning cannot be
established safely.

## What you receive

- validation of the SISSO output and holdout split;
- several strong candidate formulas instead of one automatic winner;
- predictive evidence and mathematical-domain checks;
- an explanation of why each formula may or may not be scientifically meaningful;
- clearly marked unknowns that require researcher confirmation.

SISSO-Sage does not declare a formula to be a physical law. Final interpretation
remains a scientific decision.

## Companion tool

Prefer to inspect plots, tables, and Pareto fronts in a browser? Use
[SISSO-Analyzer](https://github.com/chen121760/SISSO-Analyzer). Analyzer is for
visual, manual exploration; Sage is for AI-assisted evidence review. They are
separate but complementary tools that can examine the same SISSO results.

## Requirements and privacy

Node.js 18 or newer is sufficient. Default analysis runs locally and does not
upload your data.

Optional Jev screening sends formula evidence to the TypeSafe API and provides
separate semantic grades, checkpoint/resume, and candidate review packets. See
the [Jev setup guide (Chinese)](docs/JEV.zh-CN.md) for API access and commands.
The rubrics need researcher calibration; an AI assistant and researcher complete
the scientific interpretation.

For AI workflow details, see [AI_GUIDE.md](AI_GUIDE.md). Development and release
changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
