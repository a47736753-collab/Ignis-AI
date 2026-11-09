Evidence files (optional). With no files here the Evidence section shows clearly labelled SYNTHETIC samples and
"Not yet validated". Real files switch it to real results, but only if they pass the checks below.

validation.json     labelled results on data the weights were NOT tuned on
  { "labels": [0,1,...], "scores": [0..100,...] }
  labels: 1 if a fire happened in that zone-day (from an independent record), otherwise 0
  scores: the IGNIS AI risk score (0 to 100) for that zone-day
  Both lists must have the same length. Labels must be exactly 0 or 1. Scores must be numbers from 0 to 100.
  Metrics (ROC-AUC, Average Precision, PR-AUC trapezoid, precision, recall, F1, confusion matrix) are only shown
  when there are at least 30 zone-days with at least 5 fires and 5 non-fires. Smaller files are shown as
  "Metrics withheld". A bad file is ignored (the server logs why).

backtest.json       replays of past fires
  [ { "name": "...", "zone": "...", "scores": [8 numbers], "note": "...",
      "verified": true, "source": "where the fire record comes from", "date": "YYYY-MM-DD", "location": "..." } ]
  scores: 8 daily scores, from 7 days before ignition to the day of ignition. Use only information that was
  available at each forecast time (no future data).
  "verified" is honoured only when "source" names an independent record (for example NASA FIRMS or a forest
  department log). Without both, the entry is shown as unverified.

validation.example.json and backtest.example.json only show the FORMAT. Copying them unchanged does not
create real evidence: the example validation file is far too small, so metrics stay withheld.
Restart the server after adding or changing files.
