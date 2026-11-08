Put your real results here and the Evidence section switches from "Illustrative sample" to "Measured".

validation.json   model results on data it was NOT trained on
  { "labels": [0,1,...], "scores": [0..100,...] }
  labels: 1 if a fire happened in that zone-day, otherwise 0
  scores: the risk score (0 to 100) your model gave that zone-day
  Both lists must have the same length.

backtest.json     replays of past fires
  [ { "name": "...", "zone": "...", "scores": [8 numbers], "note": "..." } ]
  scores: 8 daily scores, from 7 days before ignition to the day of ignition.

Copy validation.example.json and backtest.example.json to see the format, then rename
the copies to validation.json and backtest.json. Restart the server after adding them.
