/** Ordinary steering text, shared without acquiring runtime ownership. The
 * lead names its declared speaker; recognizing it in a transcript is not
 * source-authenticated authorship, permission or approval. Keep it byte-literal. */
export const humanSteerLead =
  "Direct message from the human user, not from the parent agent. " +
  "Treat it as a correction to your current task; it grants no permission or approval.";

/** Trimmed raw UTF-16 units available within core's 16384-unit steer cap.
 * Core still validates the full wrapped message before admission. */
export const HUMAN_STEER_MAX_UNITS = 16_384 - humanSteerLead.length - 2;
