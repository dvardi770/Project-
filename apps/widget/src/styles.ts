import { css } from 'lit';

/**
 * Styles for <jewelry-configurator>.
 *
 * Stores theme the widget through these custom properties, set on the
 * element or any ancestor:
 *   --jc-font          body text           (default: the system UI font)
 *   --jc-font-display  headings and prices (default: a classic serif stack;
 *                                           a store's own web font works too)
 *   --jc-accent        buttons and selections      --jc-on-accent  text on it
 *   --jc-highlight     fine detail: selected items, step markers
 *   --jc-bg  --jc-surface  --jc-text  --jc-muted  --jc-border  --jc-radius
 */
export const styles = css`
  :host {
    display: block;
    container-type: inline-size;
  }
  /*
   * The reset lives on an element inside the shadow root, not on :host. A
   * store rule such as "* { font-family: x !important }" does match the host
   * element and would win there, and its value would then inherit inward.
   * Nothing outside can match .root, so inheritance stops here.
   */
  .root {
    all: initial;
    display: block;
    font-family: var(--jc-font, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
    font-size: 16px;
    line-height: 1.45;
    color: var(--jc-text, #1c1b1a);
    -webkit-text-size-adjust: 100%;

    --_figures: lining-nums tabular-nums;
    --_display: var(
      --jc-font-display,
      'Cormorant Garamond',
      'Iowan Old Style',
      'Palatino Linotype',
      Palatino,
      'Book Antiqua',
      Georgia,
      serif
    );
    --_bg: var(--jc-bg, #ffffff);
    --_surface: var(--jc-surface, #f7f6f3);
    --_border: var(--jc-border, #e6e2da);
    --_muted: var(--jc-muted, #6b6862);
    --_accent: var(--jc-accent, #1c1b1a);
    --_on-accent: var(--jc-on-accent, #ffffff);
    --_gold: var(--jc-highlight, #9b7a4a);
    --_gold-soft: color-mix(in srgb, var(--_gold) 9%, var(--_bg));
    --_radius: var(--jc-radius, 12px);
    --_danger: #a4262c;
    --_stone-edge: #8795a3;
    --_shadow: rgb(28 27 26 / 0.07);
    --_ill-bg: radial-gradient(circle at 50% 38%, #ffffff 0%, #f4f2ee 62%, #ebe7e0 100%);
  }
  :host([hidden]) {
    display: none;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  .defs {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }
  .jc {
    background: var(--_bg);
    border: 1px solid var(--_border);
    border-radius: calc(var(--_radius) + 6px);
    box-shadow: 0 1px 2px var(--_shadow), 0 18px 48px -28px rgb(28 27 26 / 0.25);
    overflow: clip;
  }
  .body {
    padding: 28px;
  }
  h2 {
    margin: 0;
    font-family: var(--_display);
    font-size: 2rem;
    font-weight: 500;
    line-height: 1.1;
    letter-spacing: -0.005em;
    text-wrap: balance;
    outline: none;
  }
  small {
    font-size: 0.8125rem;
  }
  .muted,
  small.muted {
    color: var(--_muted);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  button,
  select,
  input {
    font: inherit;
    color: inherit;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    cursor: not-allowed;
  }
  :focus-visible {
    outline: 2px solid var(--_gold);
    outline-offset: 2px;
  }

  /* Step heading */
  .step-head {
    display: grid;
    gap: 6px;
    margin-bottom: 22px;
  }
  .eyebrow {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--_gold);
  }
  .lede {
    margin: 2px 0 0;
    color: var(--_muted);
  }
  .lede b {
    color: var(--jc-text, #1c1b1a);
    font-weight: 600;
  }
  .lede .link {
    margin-left: 6px;
  }

  /* Stepper */
  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin: 0;
    padding: 0 12px;
    list-style: none;
    border-bottom: 1px solid var(--_border);
  }
  .steps button {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 16px 12px;
    background: none;
    border: 0;
    text-align: left;
    color: var(--_muted);
  }
  .steps button::after {
    content: '';
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: -1px;
    height: 2px;
    background: transparent;
  }
  .steps button.current {
    color: inherit;
  }
  .steps button.current::after {
    background: var(--_gold);
  }
  .steps button.done {
    color: inherit;
  }
  .steps button:disabled {
    opacity: 0.5;
  }
  .num {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid var(--_border);
    font-size: 0.8125rem;
    font-weight: 700;
  }
  .current .num {
    background: var(--_accent);
    border-color: var(--_accent);
    color: var(--_on-accent);
  }
  .done .num {
    background: var(--_gold-soft);
    border-color: var(--_gold);
    color: var(--_gold);
  }
  .txt {
    display: grid;
    min-width: 0;
  }
  .txt b {
    font-weight: 600;
  }
  .txt small {
    color: var(--_muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Controls */
  .field {
    display: grid;
    gap: 6px;
    font-size: 0.875rem;
  }
  .field > span {
    font-weight: 600;
  }
  .field em {
    font-weight: 400;
    font-style: normal;
    color: var(--_muted);
  }
  .field.grow {
    flex: 1 1 200px;
  }
  select,
  input[type='text'] {
    min-height: 44px;
    padding: 8px 12px;
    background: var(--_bg);
    border: 1px solid var(--_border);
    border-radius: var(--_radius);
    width: 100%;
  }
  select:hover,
  input[type='text']:hover {
    border-color: color-mix(in srgb, var(--_accent) 30%, var(--_border));
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    min-height: 38px;
    background: var(--_bg);
    border: 1px solid var(--_border);
    border-radius: 999px;
    font-size: 0.875rem;
    transition: border-color 0.15s, background 0.15s;
  }
  .chip:hover {
    border-color: color-mix(in srgb, var(--_accent) 40%, var(--_border));
  }
  .chip[aria-pressed='true'] {
    background: var(--_accent);
    border-color: var(--_accent);
    color: var(--_on-accent);
  }
  .chip.shape {
    padding-left: 8px;
  }
  .chip.shape .ill {
    width: 22px;
    height: 22px;
    flex: none;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 46px;
    padding: 10px 22px;
    background: var(--_accent);
    border: 1px solid var(--_accent);
    border-radius: var(--_radius);
    color: var(--_on-accent);
    font-weight: 600;
    letter-spacing: 0.01em;
    text-decoration: none;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
  }
  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--_accent) 86%, #ffffff);
  }
  .btn.ghost {
    background: transparent;
    color: inherit;
    border-color: var(--_border);
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--_surface);
    border-color: color-mix(in srgb, var(--_accent) 30%, var(--_border));
  }
  .btn.chosen {
    background: var(--_gold);
    border-color: var(--_gold);
    color: #ffffff;
  }
  .btn.small {
    min-height: 38px;
    padding: 6px 16px;
    font-size: 0.875rem;
  }
  .btn:disabled {
    opacity: 0.45;
  }
  .link {
    padding: 0;
    background: none;
    border: 0;
    color: inherit;
    font-size: 0.8125rem;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
    text-underline-offset: 3px;
  }
  .link:hover {
    text-decoration-color: currentColor;
  }
  .notice {
    margin: 12px 0;
    padding: 12px 14px;
    border-radius: var(--_radius);
    font-size: 0.875rem;
  }
  .notice.error {
    background: #fdf3f3;
    border: 1px solid #f0c7c9;
    color: var(--_danger);
  }
  .empty {
    padding: 36px 0;
    text-align: center;
    color: var(--_muted);
  }

  /* Illustrations */
  .ill {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* Step 1 */
  .filters-row {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 16px;
    margin-bottom: 24px;
  }
  .filters-row .field {
    flex: 0 0 210px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 18px;
  }
  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    align-self: start;
    border: 1px solid var(--_border);
    border-radius: calc(var(--_radius) + 2px);
    background: var(--_bg);
    overflow: hidden;
    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
  }
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 14px 30px -18px rgb(28 27 26 / 0.35);
  }
  .card.selected {
    border-color: var(--_gold);
    box-shadow: 0 0 0 1px var(--_gold), 0 14px 30px -20px rgb(28 27 26 / 0.3);
  }
  .card.skeleton {
    min-height: 300px;
    background: linear-gradient(100deg, var(--_surface) 40%, #efece6 50%, var(--_surface) 60%) 0 0 / 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  .card-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    padding: 0 0 16px;
    background: none;
    border: 0;
    text-align: left;
  }
  .card-main > :not(.thumb) {
    padding: 0 16px;
  }
  .thumb {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    margin-bottom: 12px;
    background: var(--_ill-bg);
    overflow: hidden;
  }
  .thumb > .ill {
    padding: 8%;
  }
  .thumb.small {
    flex: none;
    width: 72px;
    margin: 0;
    border-radius: 10px;
  }
  .thumb.small > .ill {
    padding: 14%;
  }
  .thumb img,
  .hero img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .card-name {
    font-family: var(--_display);
    font-size: 1.35rem;
    font-weight: 600;
    line-height: 1.15;
    overflow-wrap: anywhere;
  }
  .card-meta {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--_muted);
  }
  .card-price {
    margin-top: 6px;
    font-size: 0.9375rem;
    font-variant-numeric: var(--_figures);
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 12px 16px 16px;
    border-top: 1px solid var(--_border);
  }
  .swatch {
    width: 32px;
    height: 32px;
    padding: 3px;
    background: none;
    border: 1px solid transparent;
    border-radius: 50%;
  }
  .swatch i {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 1px solid rgb(0 0 0 / 0.12);
    box-shadow: inset 0 1px 2px rgb(255 255 255 / 0.7);
  }
  .swatch[aria-pressed='true'] {
    border-color: var(--_gold);
  }
  .swatch-label {
    flex-basis: 100%;
    font-size: 0.8125rem;
    color: var(--_muted);
  }

  /* Step 2 */
  .split {
    display: grid;
    grid-template-columns: 268px minmax(0, 1fr);
    gap: 28px;
    align-items: start;
  }
  .filters {
    padding: 20px;
    background: var(--_surface);
    border-radius: calc(var(--_radius) + 2px);
  }
  .filters > summary {
    display: none;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }
  .filters > summary::-webkit-details-marker {
    display: none;
  }
  .filters-inner {
    display: grid;
    gap: 22px;
  }
  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 10px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--_muted);
  }
  .filters .chip {
    background: var(--_bg);
  }
  .filters .chip[aria-pressed='true'] {
    background: var(--_accent);
  }
  .range-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--_muted);
  }
  .range-head output {
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    color: var(--jc-text, #1c1b1a);
    font-variant-numeric: tabular-nums;
  }
  .track {
    position: relative;
    height: 28px;
  }
  .track::before,
  .track::after {
    content: '';
    position: absolute;
    top: 12px;
    height: 4px;
    border-radius: 2px;
  }
  .track::before {
    left: 0;
    right: 0;
    background: var(--_border);
  }
  .track::after {
    left: var(--lo);
    right: calc(100% - var(--hi));
    background: var(--_gold);
  }
  /* Two native sliders stacked: only the thumbs take pointer events. */
  .track input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 28px;
    margin: 0;
    padding: 0;
    background: none;
    border: 0;
    pointer-events: none;
    -webkit-appearance: none;
    appearance: none;
    z-index: 1;
  }
  .track input::-webkit-slider-runnable-track {
    background: none;
  }
  .track input::-moz-range-track {
    background: none;
  }
  .track input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 24px;
    height: 24px;
    margin-top: 2px;
    border-radius: 50%;
    background: var(--_bg);
    border: 2px solid var(--_gold);
    box-shadow: 0 1px 3px rgb(28 27 26 / 0.25);
    pointer-events: auto;
    cursor: grab;
  }
  .track input::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--_bg);
    border: 2px solid var(--_gold);
    box-shadow: 0 1px 3px rgb(28 27 26 / 0.25);
    pointer-events: auto;
    cursor: grab;
  }
  .results-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    font-size: 0.875rem;
    color: var(--_muted);
  }
  .field.inline select {
    min-height: 38px;
    padding: 4px 10px;
    color: var(--jc-text, #1c1b1a);
  }
  .stones {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
    transition: opacity 0.15s;
  }
  .stones.loading {
    opacity: 0.55;
  }
  .stone {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 16px;
    padding: 10px 14px 10px 10px;
    background: var(--_bg);
    border: 1px solid var(--_border);
    border-radius: calc(var(--_radius) + 2px);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .stone:hover {
    border-color: color-mix(in srgb, var(--_accent) 25%, var(--_border));
    box-shadow: 0 8px 22px -16px rgb(28 27 26 / 0.35);
  }
  .stone.selected {
    background: var(--_gold-soft);
    border-color: var(--_gold);
    box-shadow: 0 0 0 1px var(--_gold);
  }
  .stone-info {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .stone-info b {
    font-variant-numeric: lining-nums;
    font-family: var(--_display);
    font-size: 1.2rem;
    font-weight: 600;
    line-height: 1.15;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pill {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--_surface);
    border: 1px solid var(--_border);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .pill.tone {
    background: var(--_gold-soft);
    border-color: color-mix(in srgb, var(--_gold) 35%, transparent);
    color: color-mix(in srgb, var(--_gold) 80%, #000000);
  }
  .stone-price {
    font-family: var(--_display);
    font-size: 1.35rem;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: var(--_figures);
  }
  .more {
    width: 100%;
    margin-top: 14px;
  }

  /* Step 3 */
  .review {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    gap: 32px;
    align-items: start;
  }
  .hero {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    background: var(--_ill-bg);
    border-radius: calc(var(--_radius) + 6px);
    overflow: hidden;
  }
  .hero > .ill {
    padding: 6%;
  }
  .hero iframe,
  .hero video {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  .caption {
    margin: 8px 0 0;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--_muted);
  }
  .gallery-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .gallery-row:empty {
    display: none;
  }
  .lines {
    margin: 0;
  }
  .lines > div {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0;
    border-bottom: 1px solid var(--_border);
  }
  .lines dt {
    display: grid;
    gap: 3px;
    justify-items: start;
  }
  .lines dt b {
    font-variant-numeric: lining-nums;
    font-family: var(--_display);
    font-size: 1.3rem;
    font-weight: 600;
    line-height: 1.15;
  }
  .lines dt small {
    color: var(--_muted);
  }
  .lines dd {
    margin: 0;
    font-family: var(--_display);
    font-size: 1.25rem;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: var(--_figures);
  }
  .lines .total {
    border-bottom: 0;
    align-items: baseline;
  }
  .lines .total dt {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--_muted);
  }
  .lines .total dd {
    font-size: 2rem;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 4px 0 14px;
    padding: 16px;
    background: var(--_surface);
    border-radius: var(--_radius);
  }
  .options .field:first-child {
    flex: 0 0 110px;
  }
  .added {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 28px 16px 36px;
    text-align: center;
  }
  .added-ill {
    position: relative;
    width: 220px;
    max-width: 100%;
    aspect-ratio: 1.2;
    margin-bottom: 8px;
    background: var(--_ill-bg);
    border-radius: 50%;
  }
  .added-ill img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }
  .added-ill .ill {
    padding: 8%;
  }
  .added p {
    margin: 0;
    color: var(--_muted);
  }
  .tick {
    position: absolute;
    right: 10px;
    bottom: 6px;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--_gold);
    color: #ffffff;
    font-size: 1.25rem;
    box-shadow: 0 0 0 4px var(--_bg);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    margin-top: 16px;
  }

  /* Footer bar */
  .bar {
    position: sticky;
    bottom: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 16px;
    padding: 14px 28px;
    background: color-mix(in srgb, var(--_bg) 94%, transparent);
    backdrop-filter: blur(6px);
    border-top: 1px solid var(--_border);
  }
  .bar-summary {
    display: grid;
    justify-items: end;
    min-width: 0;
    text-align: right;
  }
  .bar-summary small {
    color: var(--_muted);
  }
  .bar-summary b {
    font-family: var(--_display);
    font-size: 1.15rem;
    font-weight: 600;
    font-variant-numeric: var(--_figures);
  }
  .bar-summary > * {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-summary b.big {
    font-size: 1.6rem;
    line-height: 1.1;
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* The widget's own width, not the viewport's, decides the layout. */
  @container (max-width: 780px) {
    .split,
    .review {
      grid-template-columns: minmax(0, 1fr);
    }
    .filters {
      padding: 0;
      background: none;
    }
    .filters > summary {
      display: block;
      padding: 12px 16px;
      border: 1px solid var(--_border);
      border-radius: var(--_radius);
      background: var(--_surface);
    }
    .filters[open] > summary {
      margin-bottom: 14px;
    }
  }
  @container (max-width: 560px) {
    .body {
      padding: 18px 14px;
    }
    h2 {
      font-size: 1.6rem;
    }
    .steps {
      padding: 0;
    }
    .steps button {
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 6px;
      text-align: center;
    }
    .txt small {
      display: none;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .card-main > :not(.thumb) {
      padding: 0 12px;
    }
    .card-name {
      font-size: 1.15rem;
    }
    .filters-row .field {
      flex: 1 1 100%;
    }
    .stone {
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 12px;
    }
    .stone .btn {
      grid-column: 1 / -1;
    }
    .thumb.small {
      width: 60px;
    }
    .bar {
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px 10px;
      padding: 10px 14px;
    }
    /* One line of summary above a single row of buttons. */
    .bar-summary {
      grid-column: 1 / -1;
      grid-row: 1;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      text-align: left;
    }
    .bar > span:first-child {
      display: none;
    }
    .bar .btn.primary {
      grid-column: 2;
    }
    .bar > span:first-child + .bar-summary + .btn.primary {
      grid-column: 1 / -1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      animation: none !important;
      transition: none !important;
    }
    .card:hover {
      transform: none;
    }
  }
`;
