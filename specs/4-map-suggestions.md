# Map Suggestions for Match Entry

## Purpose

When a game ends, the reporter creates a match record and selects the map that was just played. This feature reduces that entry friction by placing the three to five most likely maps first. The reporter always confirms the actual map.

The model is global. It does not use player identity, user history, playlist, game mode, screenshots, OCR, or screenshot association. Those concerns remain separate.

## Product Behavior

The match-entry form shows a required map field with two parts:

1. Three to five suggestion buttons, ranked from most to least likely.
2. The complete predefined map dropdown, with search, for every other valid map.

No suggestion is selected by default. Submitting the form requires a deliberate map choice. A suggestion button and a dropdown choice both set the same `mapId` field.

The client requests suggestions when the form opens. It refreshes them when a confirmed match is created, so the next entry uses the newly completed sequence. If the suggestion request fails, the normal map dropdown remains fully usable.

## Source Data

Every confirmed match creates one immutable `MapSelectionEvent`. The reporter's selected map is the ground-truth label.

```ts
type MapSelectionEvent = {
  schemaVersion: 'map-selection-event/v1'
  eventId: string // UUIDv7 or ULID
  matchId: string
  mapId: string
  concludedAt: string // server UTC time
  sequenceNumber: number // globally increasing confirmed-match order
  previousMapIds: string[] // up to the three preceding confirmed maps
  suggestionModelVersion: string
  suggestedMapIds: string[] // exact displayed order; empty for fallback UI
  selectedSuggestionRank?: number // one-based when chosen from suggestions
  createdAt: string
}
```

`sequenceNumber` is assigned transactionally when the match is confirmed. The model trains only on confirmed events ordered by that number. It never trains on a screenshot's inferred or automatically associated map.

Persist events append-only in the application evidence store and maintain an operational DynamoDB projection for recent sequence reads. A correction to a match map writes a new superseding map-selection event. Training and evaluation use the effective event sequence reconstructed from supersession rules. They do not silently rewrite history.

## Ranking

The first implementation is a deterministic, data-derived ranker. It must beat a simple global-popularity baseline before a learned model is introduced.

For each candidate map, calculate:

```text
score =
  0.35 × decayed global map frequency
  0.45 × smoothed P(next map | previous map)
  0.20 × smoothed P(next map | previous two maps)
  + data-derived recency adjustment
```

Global frequency uses exponential time decay with a 90-day half-life. Transition probabilities use additive-one smoothing so maps with little history remain valid candidates.

The recency adjustment is learned from the same confirmed sequence data. It compares the observed probability that a map repeats after one or two games with that map's baseline frequency. If the observed repeat rate is lower, the score receives a soft negative adjustment. The feature never bans a map or applies a fixed manual penalty. If repeats are common, the learned adjustment is neutral or positive.

Return the top five maps, or fewer only when the allowed map catalog contains fewer than five maps. Tie-break by `mapId` for deterministic responses.

After 5,000 effective confirmed events, train a candidate-ranking model only if temporal held-out evaluation shows it improves top-three coverage and top-five coverage over the deterministic ranker. The initial learned model is gradient-boosted ranking with these features only:

- previous one, two, and three confirmed map IDs;
- transition probabilities and counts for those histories;
- decayed global frequency;
- time since the previous confirmed match;
- observed one- and two-game repeat rates.

No unconfirmed screenshot associations, reporter identity, or future events may be features.

## API

The match application exposes these authenticated routes:

| Route | Behavior |
|---|---|
| `GET /v1/maps/suggestions` | Returns the ranked map IDs, model version, and sequence number used. |
| `POST /v1/matches` | Creates the match and one `MapSelectionEvent` in the same transaction. The request includes the selected `mapId` and optional displayed suggestion order. |
| `POST /v1/matches/{matchId}/map-corrections` | Writes a superseding map-selection event. It requires the prior event ID and the replacement map ID. |

The suggestion response is:

```json
{
  "modelVersion": "map-ranker-v1",
  "basedOnSequenceNumber": 1842,
  "suggestions": [
    { "mapId": "guardian", "rank": 1 },
    { "mapId": "the-pit", "rank": 2 },
    { "mapId": "narrows", "rank": 3 }
  ]
}
```

The match-create handler validates that `mapId` is in the predefined map catalog. It records `suggestedMapIds` exactly as rendered, even if the reporter chooses a map through search or the full dropdown.

## Evaluation and Rollout

Do not judge the ranker by acceptance rate alone. Suggestions affect what the reporter sees. Evaluate against future confirmed selections using chronological train and test splits.

Track:

- top-one, top-three, and top-five coverage;
- mean reciprocal rank;
- suggestion selection rank;
- dropdown/search override rate;
- map coverage and repeated-map calibration;
- deterministic-ranker versus global-popularity baseline.

Rollout thresholds:

| Effective confirmed events | Behavior |
|---|---|
| 0–99 | Fixed map catalog order only; record selections. |
| 100–499 | Time-decayed global-frequency suggestions. |
| 500–4,999 | Deterministic transition ranker. |
| 5,000+ | Evaluate the learned ranker offline. Deploy it only when it improves held-out top-three and top-five coverage without reducing map catalog coverage materially. |

## Acceptance Criteria

- The reporter can always select any predefined map even if suggestions fail or are wrong.
- No map is preselected by the UI.
- Every confirmed map selection records the exact candidate ordering shown to the reporter.
- The prediction reads only prior confirmed map events in sequence order.
- A map correction preserves the original event and changes the effective sequence through an explicit superseding event.
- Unit tests cover smoothing, deterministic tie-breaks, repeated-map adjustment, empty history, and catalog changes.
- Integration tests confirm that a match create atomically creates its map-selection event and that screenshot association does not alter model training data.
