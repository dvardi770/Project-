'use client';

import { useActionState, useState } from 'react';
import {
  MAX_TIERS,
  ORIGINS,
  ROUNDINGS,
  previewPrice,
  tierBounds,
  type MarkupMatrixData,
  type MatrixCell,
} from '../../lib/markup-shared';
import { saveMarkupAction, type SaveState } from './actions';

const ORIGIN_LABEL = { NATURAL: 'Natural', LAB_GROWN: 'Lab-grown' } as const;
const ROUNDING_LABEL: Record<(typeof ROUNDINGS)[number], string> = {
  NONE: 'No rounding (to the cent)',
  NEAREST_1: 'Nearest $1',
  NEAREST_10: 'Nearest $10',
  NEAREST_100: 'Nearest $100',
  ENDING_99: 'End in .99',
};
/** Cost used for the worked example under each cell. */
const EXAMPLE_COST = 1000;

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });

/** Empty and invalid inputs become 0 so the example never shows NaN; the server validates for real. */
const num = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function MarkupForm({ initial, saved }: { initial: MarkupMatrixData; saved: boolean }) {
  const [matrix, setMatrix] = useState<MarkupMatrixData>(initial);
  const [dirty, setDirty] = useState(!saved);
  const [state, action, pending] = useActionState<SaveState, FormData>(async (previous, formData) => {
    const result = await saveMarkupAction(previous, formData);
    if (result.ok) setDirty(false);
    return result;
  }, {});

  const update = (next: MarkupMatrixData) => {
    setMatrix(next);
    setDirty(true);
  };

  const setCell = (row: number, origin: (typeof ORIGINS)[number], patch: Partial<MatrixCell>) =>
    update({
      ...matrix,
      rows: matrix.rows.map((r, i) => (i === row ? { ...r, [origin]: { ...r[origin], ...patch } } : r)),
    });

  const setBreak = (index: number, value: number) =>
    update({ ...matrix, breaks: matrix.breaks.map((b, i) => (i === index ? value : b)) });

  /** Split the last tier: it keeps its markups, and a new top tier copies them. */
  const addTier = () => {
    const last = matrix.breaks.at(-1) ?? 0;
    const lastRow = matrix.rows.at(-1)!;
    update({
      ...matrix,
      breaks: [...matrix.breaks, last === 0 ? 1 : last + 1],
      rows: [...matrix.rows, { NATURAL: { ...lastRow.NATURAL }, LAB_GROWN: { ...lastRow.LAB_GROWN } }],
    });
  };

  /** Remove a tier; the tier below it grows to cover the gap. */
  const removeTier = (row: number) =>
    update({
      ...matrix,
      breaks: matrix.breaks.filter((_, i) => i !== Math.max(0, row - 1)),
      rows: matrix.rows.filter((_, i) => i !== row),
    });

  // Shown as the merchant types; the same rule is enforced on the server.
  const outOfOrder = matrix.breaks.some((b, i) => !(b > 0) || (i > 0 && b <= matrix.breaks[i - 1]!));

  return (
    <form action={action} className="matrix">
      <input type="hidden" name="matrix" value={JSON.stringify(matrix)} />

      {state.ok && !dirty ? (
        <p className="notice ok" role="status">
          Saved. New prices appear on your store within a minute.
        </p>
      ) : null}
      {state.errors?.length ? (
        <div className="notice error" role="alert">
          {state.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      ) : null}

      <div className="card">
        <h2>Diamond markup by carat weight</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Carat weight</th>
                {ORIGINS.map((o) => (
                  <th scope="col" key={o}>
                    {ORIGIN_LABEL[o]}
                  </th>
                ))}
                <th scope="col">
                  <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    &nbsp;
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row, i) => {
                const { min, max } = tierBounds(matrix.breaks, i);
                const tierText = min === null ? 'Under' : max === null ? `${min} ct and above` : `${min} ct up to`;
                return (
                  <tr key={i}>
                    <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '0.9375rem', color: 'inherit' }}>
                      <span className="tier">
                        {tierText}
                        {max !== null ? (
                          <>
                            <input
                              type="number"
                              min="0.01"
                              max="100"
                              step="0.01"
                              aria-label={`Upper carat limit of tier ${i + 1}`}
                              value={matrix.breaks[i]}
                              onChange={(e) => setBreak(i, num(e.target.value))}
                            />
                            ct
                          </>
                        ) : null}
                      </span>
                    </th>
                    {ORIGINS.map((o) => (
                      <td key={o}>
                        <span className="pair">
                          <input
                            type="number"
                            min="0"
                            max="1000"
                            step="0.01"
                            aria-label={`${ORIGIN_LABEL[o]} markup percent, tier ${i + 1}`}
                            value={row[o].percent}
                            onChange={(e) => setCell(i, o, { percent: num(e.target.value) })}
                          />
                          % +&nbsp;$
                          <input
                            type="number"
                            min="0"
                            step="1"
                            aria-label={`${ORIGIN_LABEL[o]} flat amount, tier ${i + 1}`}
                            value={row[o].fixed}
                            onChange={(e) => setCell(i, o, { fixed: num(e.target.value) })}
                          />
                        </span>
                        <span className="example">
                          {usd(EXAMPLE_COST)} cost sells for {usd(previewPrice(EXAMPLE_COST, row[o], matrix.rounding))}
                        </span>
                      </td>
                    ))}
                    <td className="num">
                      {matrix.rows.length > 1 ? (
                        <button type="button" className="linklike small" onClick={() => removeTier(i)}>
                          Remove<span style={{ position: 'absolute', left: -9999 }}> tier {i + 1}</span>
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {outOfOrder ? (
          <p className="notice error" role="alert" style={{ margin: '16px 0 0' }}>
            Carat tiers must go from smallest to largest, with no repeats.
          </p>
        ) : null}
        <div className="row-actions">
          <button type="button" className="btn ghost small" onClick={addTier} disabled={matrix.rows.length >= MAX_TIERS}>
            Add a carat tier
          </button>
          <span className="muted small">Each tier includes its lower weight and stops just below its upper one.</span>
        </div>
      </div>

      <div className="card grid2">
        <label className="field">
          Round diamond prices
          <select
            value={matrix.rounding}
            onChange={(e) => update({ ...matrix, rounding: e.target.value as MarkupMatrixData['rounding'] })}
          >
            {ROUNDINGS.map((r) => (
              <option key={r} value={r}>
                {ROUNDING_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Markup on ring settings (%)
          <input
            type="number"
            min="0"
            max="1000"
            step="0.01"
            placeholder="Not for sale"
            value={matrix.settingPercent ?? ''}
            onChange={(e) => update({ ...matrix, settingPercent: e.target.value === '' ? null : num(e.target.value) })}
          />
          <span className="muted small" style={{ fontWeight: 400 }}>
            Applied to the casting cost. Leave empty and settings are hidden from your store.
          </span>
        </label>
      </div>

      <div className="row-actions">
        <button type="submit" className="btn" disabled={pending || outOfOrder || !dirty}>
          {pending ? 'Saving…' : 'Save markup'}
        </button>
        {dirty ? <span className="muted small">You have unsaved changes.</span> : null}
      </div>
    </form>
  );
}
