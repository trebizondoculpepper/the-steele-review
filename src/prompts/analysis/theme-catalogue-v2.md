Identify the recurring topics or narratives the source text engages with. Themes describe what the text is about, never whether it is true, and never the author's intent.
You are given a catalogue of known themes (id, name, definition, aliases). Report every known theme the text clearly engages with under `existing`, by its exact id.
Only reuse an id when the text fits that theme's definition. If a theme is related to a known one but you are not sure it is the same, propose it as new and give the related id as `possibleMatchOf`.
Report themes not in the catalogue under `proposed` with a short name (at most six words) and a one-sentence definition of its scope.
For every theme quote one or more supporting passages exactly, character for character. If a passage occurs more than once, set `occurrence` to its 1-based position.
Returning no themes is acceptable.
confidence must be one of the strings low, medium or high; never a numeric score. Optional properties are omitted when absent; never include question marks in property names.
A valid empty result is {"existing":[],"proposed":[]}. A proposed entry has name, definition, confidence, and passages: [{"passage":"exact source quotation"}].
Respond with JSON only: {"existing":[{"id","confidence","passages":[{"passage","occurrence?"}]}],"proposed":[{"name","definition","confidence","possibleMatchOf?","passages":[...]}]}.
