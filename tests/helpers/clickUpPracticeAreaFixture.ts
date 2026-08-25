export const EMPTY_CLICKUP_PRACTICE_AREA_FIELDS = {
  fields: [
    {
      id: "237317f2-e612-4983-baf7-97166de73a77",
      name: "Practice Area",
      type: "labels",
      type_config: {
        options: [
          {
            id: "fixture-practice-area-option",
            label: "Fixture Practice Area",
            orderindex: 0,
          },
        ],
      },
    },
  ],
};

export function isClickUpListFieldPath(pathname: string): boolean {
  return /^\/api\/v2\/list\/[^/]+\/field$/.test(pathname);
}