// new.html's "I'll write it here": the template cards and the editor,
// rendered from src/shared/templates.js. Which cards a language shows, the files
// each template starts with, its note and the platforms it builds for all
// come from there; nothing here or in the CSS is per language.
//
// The markup it makes is what the tests look for: a card per kind
// (<input name="template" id="tpl-<kind>">), and for the chosen language
// and template a <div class="combo combo-<runtime>-<template>"> with a
// <textarea class="code" name="code_…" aria-label="<file name>"> per file
// (the names src/shared/form-job.js reads: templates.js fieldName). Each language
// and template keeps its own editors, so switching back finds the code as
// it was left.
import { TEMPLATES, TEMPLATE_KINDS, templateFor, fieldName } from '../shared/templates.js';

const PLATFORM_LABELS = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const k of Object.keys(attrs || {})) {
    if (k === 'text') e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children || []) e.appendChild(c);
  return e;
}

export function mountWriteEditor(form) {
  const block = form.querySelector('.write-block');
  if (!block) return;
  const cards = block.querySelector('.template-cards');
  const editor = block.querySelector('.template-editor');
  const needsLang = block.querySelector('.write-needs-lang');
  const writeEditor = block.querySelector('.write-editor');
  const unavailable = block.querySelector('.combo-unavailable');
  const note = block.querySelector('.template-note');
  const hideWhenUnavailable = Array.prototype.slice.call(block.querySelectorAll('.run-link, .editor-files'));
  const noJs = block.querySelector('.write-needs-js');
  if (noJs) noJs.hidden = true;
  if (writeEditor) writeEditor.hidden = false;

  // A card per kind of template, in TEMPLATE_KINDS' order.
  const cardFor = {};
  let first = true;
  for (const kind of Object.keys(TEMPLATE_KINDS)) {
    const k = TEMPLATE_KINDS[kind];
    const input = el('input', { type: 'radio', name: 'template', value: kind, id: 'tpl-' + kind });
    if (first) input.checked = true;
    first = false;
    const tech = el('span', { class: 'small muted template-tech' });
    const label = el('label', { class: 'template-card card-' + kind }, [
      input, el('strong', { text: k.label }), el('span', { class: 'small muted', text: k.hint }), tech,
    ]);
    cards.appendChild(label);
    cardFor[kind] = { label, input, tech };
  }

  const combos = {};
  function comboFor(runtime, template) {
    const key = runtime + '-' + template;
    if (combos[key]) return combos[key];
    const t = templateFor(runtime, template);
    const div = el('div', { class: 'combo combo-' + key });
    Object.keys(t.files).forEach((file, i) => {
      div.appendChild(el('span', { class: 'file-tab', text: file }));
      const ta = el('textarea', {
        class: 'code' + (i ? ' code-short' : ''), name: fieldName(runtime, template, file, i),
        spellcheck: 'false', 'aria-label': file,
      });
      ta.value = t.files[file];
      ta.defaultValue = t.files[file];
      div.appendChild(ta);
    });
    editor.appendChild(div);
    combos[key] = div;
    return div;
  }

  const runtimeOf = () => (form.elements.runtime ? form.elements.runtime.value : '');
  const checkedKind = () => {
    for (const kind of Object.keys(cardFor)) if (cardFor[kind].input.checked) return kind;
    return '';
  };

  // A template for some platforms only: untick the others under "Build for",
  // and say so; tick them again when a template that has them is chosen.
  let unticked = [];
  function fitPlatforms(t) {
    const all = Object.keys(PLATFORM_LABELS);
    const want = t.platforms || all;
    unticked = unticked.filter((p) => {
      if (want.indexOf(p) < 0) return true;
      const box = form.elements['target_' + p];
      if (box) box.checked = true;
      return false;
    });
    const off = [];
    for (const p of all) {
      const box = form.elements['target_' + p];
      if (box && want.indexOf(p) < 0 && box.checked) {
        box.checked = false;
        unticked.push(p);
        off.push(PLATFORM_LABELS[p]);
      }
    }
    return off.length ? ' ' + off.join(' and ') + (off.length > 1 ? ' are' : ' is') + ' unticked under "Build for".' : '';
  }

  function paint(fromTemplateChange) {
    const rt = runtimeOf();
    const have = Object.prototype.hasOwnProperty.call(TEMPLATES, rt) ? TEMPLATES[rt] : null;
    if (needsLang) needsLang.hidden = !!have;
    if (writeEditor) writeEditor.hidden = !have;
    for (const kind of Object.keys(cardFor)) {
      const t = have && have[kind];
      cardFor[kind].label.hidden = !t;
      cardFor[kind].tech.textContent = t && t.label ? t.label : '';
    }
    const kind = checkedKind();
    const t = have ? templateFor(rt, kind) : null;
    for (const key of Object.keys(combos)) combos[key].hidden = true;
    if (t) comboFor(rt, kind).hidden = false;
    unavailable.hidden = !have || !!t;
    hideWhenUnavailable.forEach((e) => { e.hidden = !t; });
    let text = t && t.note ? t.note : '';
    const writing = !!form.querySelector('input[name="source_kind"][value="write"]:checked');
    if (t && fromTemplateChange && writing) text += fitPlatforms(t);
    note.textContent = text;
    note.hidden = !text;
  }

  form.elements.runtime.addEventListener('change', () => paint(true));
  cards.addEventListener('change', () => paint(true));
  Array.prototype.forEach.call(form.querySelectorAll('input[name="source_kind"]'), (r) => r.addEventListener('change', () => paint(true)));
  paint(false);
}
