// new.html's fields as the page starts them (the ones shared/form-job.js reads),
// with "I'll write it here" chosen. The launch and build fields are left as
// they were, so the template's own commands are used.
//
// Shared by build.mjs (which builds every template's installer) and
// plan-test.mjs (which only resolves their plans).
import { TEMPLATES, templateFields } from '../../shared/templates.js';

export function formFor(rt, id, platforms, mode = 'C') {
  const t = TEMPLATES[rt][id];
  const fields = {
    app_name: 'Template ' + rt + ' ' + id, source_kind: 'write', runtime: rt, template: id, rv_mode: 'newest',
    mode: { A: 'ours', B: 'yours', C: 'unsigned' }[mode], root: 'user', rootname: 'ib', install_cmd: '',
    cleanup_tools: 'remove', cleanup_fail: 'remove', uninstall_data: 'ask', icon_choice: 'default',
  };
  const ticked = new Set(['shortcut_menu', 'uninstaller', 'cleanup_pkg_cache'].concat(platforms.map((p) => 'target_' + p)));
  const code = templateFields(rt, id);
  for (const name of Object.keys(code)) fields[name] = t.files[code[name]];
  return {
    val: (name) => (Object.prototype.hasOwnProperty.call(fields, name) ? String(fields[name]) : ''),
    checked: (name) => ticked.has(name),
    has: (name) => Object.prototype.hasOwnProperty.call(fields, name),
    launchEdited: () => false,
    buildEdited: () => false,
  };
}
