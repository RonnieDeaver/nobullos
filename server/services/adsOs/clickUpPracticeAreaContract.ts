import {
  CLICKUP_PRACTICE_AREA_FIELD_ID,
  CLICKUP_PRACTICE_AREA_FIELD_NAME,
  CLICKUP_PRACTICE_AREA_FIELD_TYPE,
} from "./paidSearchRoleContract";

/** Fail-closed canonical Practice Area field/selection contract violation. */
export class ClickUpPracticeAreaContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickUpPracticeAreaContractError";
  }
}

export interface PracticeAreaOption {
  id: string;
  label: string;
  orderindex: number;
}

export interface PracticeAreaFieldContract {
  id: string;
  name: string;
  type: string;
  options: PracticeAreaOption[];
}

export function resolvePracticeAreaFieldContract(
  fields: any[],
): PracticeAreaFieldContract {
  const matches = fields.filter(
    (field) => field?.name === CLICKUP_PRACTICE_AREA_FIELD_NAME,
  );
  if (matches.length === 0) {
    throw new ClickUpPracticeAreaContractError(
      `Canonical ClickUp list is missing the exact "${CLICKUP_PRACTICE_AREA_FIELD_NAME}" custom field.`,
    );
  }
  if (matches.length !== 1) {
    throw new ClickUpPracticeAreaContractError(
      `Canonical ClickUp list has ${matches.length} exact "${CLICKUP_PRACTICE_AREA_FIELD_NAME}" custom fields; expected one.`,
    );
  }

  const field = matches[0];
  if (field?.id !== CLICKUP_PRACTICE_AREA_FIELD_ID) {
    throw new ClickUpPracticeAreaContractError(
      `"${CLICKUP_PRACTICE_AREA_FIELD_NAME}" field ID drifted; expected ${CLICKUP_PRACTICE_AREA_FIELD_ID}.`,
    );
  }
  if (field?.type !== CLICKUP_PRACTICE_AREA_FIELD_TYPE) {
    throw new ClickUpPracticeAreaContractError(
      `"${CLICKUP_PRACTICE_AREA_FIELD_NAME}" field has type "${String(field?.type ?? "") || "missing"}"; expected "${CLICKUP_PRACTICE_AREA_FIELD_TYPE}".`,
    );
  }

  const rawOptions = field?.type_config?.options;
  if (!Array.isArray(rawOptions)) {
    throw new ClickUpPracticeAreaContractError(
      `"${CLICKUP_PRACTICE_AREA_FIELD_NAME}" options are missing or malformed.`,
    );
  }
  if (rawOptions.length === 0) {
    throw new ClickUpPracticeAreaContractError(
      `"${CLICKUP_PRACTICE_AREA_FIELD_NAME}" has no canonical options.`,
    );
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  const orderindexes = new Set<number>();
  const options: PracticeAreaOption[] = rawOptions.map(
    (option: any, sourceIndex: number) => {
      const id = typeof option?.id === "string" ? option.id : "";
      const label = typeof option?.label === "string" ? option.label : "";
      const orderindex = option?.orderindex;
      if (
        !id ||
        id.trim() !== id ||
        !label ||
        label.trim() !== label ||
        typeof orderindex !== "number" ||
        !Number.isInteger(orderindex) ||
        orderindex < 0
      ) {
        throw new ClickUpPracticeAreaContractError(
          `"${CLICKUP_PRACTICE_AREA_FIELD_NAME}" option ${sourceIndex + 1} is malformed.`,
        );
      }
      if (ids.has(id) || labels.has(label) || orderindexes.has(orderindex)) {
        throw new ClickUpPracticeAreaContractError(
          `"${CLICKUP_PRACTICE_AREA_FIELD_NAME}" options contain a duplicate ID, label, or order index.`,
        );
      }
      ids.add(id);
      labels.add(label);
      orderindexes.add(orderindex);
      return { id, label, orderindex };
    },
  );
  options.sort((a, b) => a.orderindex - b.orderindex);
  return {
    id: CLICKUP_PRACTICE_AREA_FIELD_ID,
    name: CLICKUP_PRACTICE_AREA_FIELD_NAME,
    type: CLICKUP_PRACTICE_AREA_FIELD_TYPE,
    options,
  };
}

export function decodePracticeAreaSelection(
  field: any,
  contract: PracticeAreaFieldContract,
  parentTaskId: string,
): string[] {
  const raw = field?.value;
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ClickUpPracticeAreaContractError(
      `ClickUp parent ${parentTaskId} has a malformed Practice Area selection (expected an array).`,
    );
  }
  const knownIds = new Set(contract.options.map((option) => option.id));
  const selectedIds = new Set<string>();
  for (const entry of raw) {
    const id =
      typeof entry === "string"
        ? entry
        : entry &&
            typeof entry === "object" &&
            typeof entry.id === "string"
          ? entry.id
          : "";
    if (!id || !knownIds.has(id)) {
      throw new ClickUpPracticeAreaContractError(
        `ClickUp parent ${parentTaskId} has an unknown Practice Area option ID.`,
      );
    }
    if (selectedIds.has(id)) {
      throw new ClickUpPracticeAreaContractError(
        `ClickUp parent ${parentTaskId} has a duplicate Practice Area option ID.`,
      );
    }
    selectedIds.add(id);
  }
  return contract.options
    .filter((option) => selectedIds.has(option.id))
    .map((option) => option.label);
}