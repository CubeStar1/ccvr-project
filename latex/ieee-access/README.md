# FalconVQA — IEEE Access manuscript

`access.tex` is the main document. The IEEE Access class and template artwork
are from the supplied IDP paper package; the manuscript, diagrams, and tables
are specific to FalconVQA. The bundled class uses the same blue in process
CMYK when compiled under XeTeX, which lacks the template's pdfTeX spot-color
primitives.

Compile in this directory with `tectonic access.tex` or
`latexmk -pdf access.tex`. On Overleaf, upload the package contents and select
`access.tex` as the main document. No BibTeX or external image downloads are
required.

## Updating the draft

- Edit `evaluation.tex` to add fresh measurements. Keep the VIDRA pilot and
  predecessor-backend observations separate unless both systems are rerun
  under the same protocol.
- The current pilot is reproducible with the script and raw data in
  `latex/benchmarks/` in the repository (packaged as `benchmarks/` in the ZIP).
  The historical source is `latex/phases.tex`, in *Dataset Creation* and
  *Product Performance*.
- The author list and affiliations follow the project synopsis for this
  working draft. Confirm author order, corresponding author, affiliations,
  funding, and acknowledgments with the team before submission. Add author
  biographies if required. Do not assign a DOI, volume, or publication date.
- Before submission, replace or extend the component pilot with the results of
  the real-video protocol, and update the abstract, discussion, and conclusion
  to match what was actually evaluated. Check the journal's current submission
  and AI-use disclosure requirements.
