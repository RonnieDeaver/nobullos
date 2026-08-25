import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CRITERIA_MAX_CONDITIONS_PER_GROUP,
  CRITERIA_MAX_GROUPS,
  criteriaFieldRegistry,
  criteriaOperatorLabels,
  operatorsByFieldType,
  valuelessOperators,
  type CriteriaCondition,
  type CriteriaEntityType,
  type CriteriaOperator,
  type CriteriaSet,
} from "@shared/criteria";

/**
 * Shared criteria-set builder (groups of conditions with AND/OR
 * combinators) over the shared criteria field registry. Extracted verbatim
 * from the Tags & Segments admin page (Task #4329) so scoring fit rules
 * (Task #4333) configure record-property criteria with the exact same
 * control. Keep presentation-neutral — each admin surface wraps it in its
 * own dialog/layout.
 */

export function emptyCondition(entityType: CriteriaEntityType): CriteriaCondition {
  const field = criteriaFieldRegistry[entityType][0];
  return { field: field.key, operator: operatorsByFieldType[field.type][0], value: "" };
}

export function emptyCriteria(entityType: CriteriaEntityType): CriteriaSet {
  return {
    combinator: "and",
    groups: [{ combinator: "and", conditions: [emptyCondition(entityType)] }],
  };
}

export function CriteriaBuilder({
  entityType,
  value,
  onChange,
}: {
  entityType: CriteriaEntityType;
  value: CriteriaSet;
  onChange: (next: CriteriaSet) => void;
}) {
  const fields = criteriaFieldRegistry[entityType];
  const fieldByKey = useMemo(
    () => new Map(fields.map((f) => [f.key, f])),
    [fields],
  );

  function setCondition(gi: number, ci: number, next: CriteriaCondition) {
    const groups = value.groups.map((g, i) =>
      i === gi
        ? { ...g, conditions: g.conditions.map((c, j) => (j === ci ? next : c)) }
        : g,
    );
    onChange({ ...value, groups });
  }

  return (
    <div className="space-y-3" data-testid="criteria-builder">
      <div className="flex items-center gap-2 text-sm">
        <span>Match</span>
        <Select
          value={value.combinator}
          onValueChange={(v) => onChange({ ...value, combinator: v as "and" | "or" })}
        >
          <SelectTrigger className="h-8 w-24" data-testid="select-set-combinator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">ALL</SelectItem>
            <SelectItem value="or">ANY</SelectItem>
          </SelectContent>
        </Select>
        <span>of the condition groups:</span>
      </div>

      {value.groups.map((group, gi) => (
        <div key={gi} className="space-y-2 border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Group {gi + 1} — match</span>
              <Select
                value={group.combinator}
                onValueChange={(v) =>
                  onChange({
                    ...value,
                    groups: value.groups.map((g, i) =>
                      i === gi ? { ...g, combinator: v as "and" | "or" } : g,
                    ),
                  })
                }
              >
                <SelectTrigger className="h-7 w-20 text-xs" data-testid={`select-group-combinator-${gi}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">ALL</SelectItem>
                  <SelectItem value="or">ANY</SelectItem>
                </SelectContent>
              </Select>
              <span>of:</span>
            </div>
            {value.groups.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive"
                onClick={() =>
                  onChange({ ...value, groups: value.groups.filter((_, i) => i !== gi) })
                }
                data-testid={`button-remove-group-${gi}`}
              >
                Remove group
              </Button>
            )}
          </div>

          {group.conditions.map((cond, ci) => {
            const field = fieldByKey.get(cond.field) ?? fields[0];
            const operators = operatorsByFieldType[field.type];
            const operator = operators.includes(cond.operator)
              ? cond.operator
              : operators[0];
            const valueless = valuelessOperators.includes(operator);
            return (
              <div key={ci} className="flex flex-wrap items-center gap-2">
                <Select
                  value={field.key}
                  onValueChange={(key) => {
                    const nextField = fieldByKey.get(key) ?? fields[0];
                    setCondition(gi, ci, {
                      field: nextField.key,
                      operator: operatorsByFieldType[nextField.type][0],
                      value: "",
                    });
                  }}
                >
                  <SelectTrigger className="h-8 w-44" data-testid={`select-field-${gi}-${ci}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fields.map((f) => (
                      <SelectItem key={f.key} value={f.key}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={operator}
                  onValueChange={(op) =>
                    setCondition(gi, ci, {
                      field: field.key,
                      operator: op as CriteriaOperator,
                      value: valuelessOperators.includes(op as CriteriaOperator)
                        ? undefined
                        : cond.value ?? "",
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-40" data-testid={`select-operator-${gi}-${ci}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {operators.map((op) => (
                      <SelectItem key={op} value={op}>
                        {criteriaOperatorLabels[op]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {!valueless && (
                  <Input
                    className="h-8 w-40"
                    type={
                      field.type === "number"
                        ? "number"
                        : field.type === "date"
                          ? "date"
                          : "text"
                    }
                    value={cond.value == null ? "" : String(cond.value)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setCondition(gi, ci, {
                        field: field.key,
                        operator,
                        value:
                          field.type === "number"
                            ? raw === ""
                              ? ""
                              : Number(raw)
                            : raw,
                      });
                    }}
                    placeholder="Value"
                    data-testid={`input-value-${gi}-${ci}`}
                  />
                )}

                {group.conditions.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() =>
                      onChange({
                        ...value,
                        groups: value.groups.map((g, i) =>
                          i === gi
                            ? { ...g, conditions: g.conditions.filter((_, j) => j !== ci) }
                            : g,
                        ),
                      })
                    }
                    data-testid={`button-remove-condition-${gi}-${ci}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            );
          })}

          {group.conditions.length < CRITERIA_MAX_CONDITIONS_PER_GROUP && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                onChange({
                  ...value,
                  groups: value.groups.map((g, i) =>
                    i === gi
                      ? { ...g, conditions: [...g.conditions, emptyCondition(entityType)] }
                      : g,
                  ),
                })
              }
              data-testid={`button-add-condition-${gi}`}
            >
              <Plus className="mr-1 h-3 w-3" /> Condition
            </Button>
          )}
        </div>
      ))}

      {value.groups.length < CRITERIA_MAX_GROUPS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onChange({
              ...value,
              groups: [
                ...value.groups,
                { combinator: "and", conditions: [emptyCondition(entityType)] },
              ],
            })
          }
          data-testid="button-add-group"
        >
          <Plus className="mr-1 h-3 w-3" /> Group
        </Button>
      )}
    </div>
  );
}
