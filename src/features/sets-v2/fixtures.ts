import {
  DEFAULT_CANVASES,
  type DataBinding,
  type SceneNode,
  type SetDefinition,
  type Orientation,
} from "./scene";
const fraction = (index: number, extent: number): DataBinding => ({
  data: {
    channel: "audiencePoll",
    path: ["results", "choices", String(index), "fraction"],
  },
  fallback: 0,
  map: { input: [0, 1], output: [0, extent] },
});
const caption = (value: string): DataBinding => ({
  data: { channel: "audiencePoll", path: ["question"] },
  fallback: value,
});
/** Two independent skins consume one interaction contract in both orientations. */
export function pollSet(style: "bars" | "spotlight"): SetDefinition {
  return {
    schema: "producer.set/2",
    id: "poll-" + style,
    revision: 1,
    name: style === "bars" ? "Audience Desk" : "Audience Spotlight",
    inputs: [{ id: "host", label: "Host camera", required: true }],
    channels: ["audiencePoll"],
    canvases: (["landscape", "portrait"] as Orientation[]).map(
      (orientation) => {
        const { width, height } = DEFAULT_CANVASES[orientation];
        const vertical = orientation === "portrait";
        const board = {
          x: vertical ? 60 : 850,
          y: vertical ? 1050 : 160,
          width: vertical ? 960 : 1000,
          height: vertical ? 740 : 760,
        };
        const children: SceneNode[] = [
          {
            id: "background",
            kind: "graphic",
            graphic: style === "bars" ? "navy" : "gold",
            bounds: { x: 0, y: 0, width, height },
          },
          {
            id: "host",
            kind: "source",
            input: "host",
            fit: "cover",
            bounds: {
              x: 60,
              y: vertical ? 160 : 160,
              width: vertical ? 960 : 720,
              height: vertical ? 810 : 760,
            },
          },
          {
            id: "poll",
            kind: "group",
            bounds: board,
            mask: { kind: "rounded", radius: 32 },
            isolate: true,
            children: [
              {
                id: "poll-background",
                kind: "graphic",
                graphic: "panel",
                bounds: {
                  x: 0,
                  y: 0,
                  width: board.width,
                  height: board.height,
                },
              },
              {
                id: "question",
                kind: "text",
                bounds: { x: 36, y: 36, width: board.width - 72, height: 160 },
                properties: {
                  text: caption("Ask the audience"),
                  fontSize: vertical ? 48 : 44,
                  color: "#fff2ce",
                },
              },
              ...[0, 1].flatMap((i): SceneNode[] =>
                style === "bars"
                  ? [
                      {
                        id: "label" + i,
                        kind: "text",
                        bounds: {
                          x: 36,
                          y: 240 + i * 180,
                          width: board.width - 72,
                          height: 50,
                        },
                        properties: {
                          text: i ? "Choice B" : "Choice A",
                          color: "#ffffff",
                          fontSize: 32,
                        },
                      },
                      {
                        id: "bar" + i,
                        kind: "graphic",
                        graphic: i ? "pink" : "gold",
                        bounds: {
                          x: 36,
                          y: 300 + i * 180,
                          width: 0,
                          height: 54,
                        },
                        properties: { width: fraction(i, board.width - 72) },
                      },
                    ]
                  : [
                      {
                        id: "card" + i,
                        kind: "group",
                        bounds: {
                          x: 36 + i * (board.width / 2),
                          y: 260,
                          width: board.width / 2 - 54,
                          height: 350,
                        },
                        mask: { kind: "rounded", radius: 40 },
                        isolate: true,
                        children: [
                          {
                            id: "candidate" + i,
                            kind: "graphic",
                            graphic: i ? "pink" : "gold",
                            bounds: {
                              x: 0,
                              y: 0,
                              width: board.width / 2 - 54,
                              height: 350,
                            },
                            properties: {
                              opacity: {
                                ...fraction(i, 1),
                                map: { input: [0, 1], output: [0.2, 1] },
                              },
                            },
                          },
                          {
                            id: "choice" + i,
                            kind: "text",
                            bounds: {
                              x: 20,
                              y: 100,
                              width: board.width / 2 - 94,
                              height: 150,
                            },
                            properties: {
                              text: i ? "B" : "A",
                              fontSize: 100,
                              color: "#ffffff",
                            },
                          },
                        ],
                      },
                    ],
              ),
              {
                id: "reveal-label",
                kind: "text",
                bounds: {
                  x: 36,
                  y: board.height - 110,
                  width: board.width - 72,
                  height: 60,
                },
                properties: {
                  text: "Results appear after the host reveals them.",
                  color: "#ddd3c4",
                  fontSize: 24,
                },
              },
            ],
          },
        ];
        return {
          id: orientation,
          orientation,
          width,
          height,
          root: {
            id: "root",
            kind: "group",
            bounds: { x: 0, y: 0, width, height },
            children,
          },
        };
      },
    ),
  };
}
