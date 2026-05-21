import { api } from '/shared/api.js';
import { el, clear, toast, fmtDate } from '/shared/ui.js';

const CATEGORIES = [
  ['', '— pick one —'], ['mens', "Men's"], ['womens', "Women's"], ['youth', 'Youth'], ['mixed', 'Mixed'],
];
const ROLES = [
  ['', '— pick one —'], ['batsman', 'Batsman'], ['bowler', 'Bowler'],
  ['all-rounder', 'All-rounder'], ['wicket-keeper', 'Wicket-keeper'],
];
const BATTING_STYLES = [
  ['', '— pick one —'], ['right_hand', 'Right hand'], ['left_hand', 'Left hand'],
];
const BOWLING_STYLES = [
  ['', '— pick one —'], ['right_arm', 'Right arm'], ['left_arm', 'Left arm'], ['none', 'None'],
];
const BOWLING_TYPES = [
  ['', '— pick one —'],
  ['fast', 'Fast'], ['fast_medium', 'Fast-Medium'],
  ['medium', 'Medium'], ['medium_fast', 'Medium-Fast'],
  ['off_spin', 'Off Spin'], ['leg_spin', 'Leg Spin'],
  ['left_arm_orthodox', 'Left-arm Orthodox'], ['left_arm_chinaman', 'Left-arm Chinaman'],
  ['none', 'None'],
];

const PROFILE_BADGES = {
  placeholder:     { label: 'Placeholder',     cls: 'badge status-draft' },
  invited:         { label: 'Invited',         cls: 'badge status-pending' },
  self_registered: { label: 'Self-registered', cls: 'badge status-active' },
  verified:        { label: 'Verified ✓',      cls: 'badge status-completed' },
};

function initialsFor(p) {
  const f = (p.first_name || '').trim();
  const l = (p.last_name || '').trim();
  if (f || l) return ((f[0] || '') + (l[0] || '')).toUpperCase();
  return (p.name || '?').trim().slice(0, 1).toUpperCase();
}

function selectEl(options, value, onChange) {
  const sel = el('select', {},
    options.map(([v, label]) => el('option', { value: v, selected: v === (value || '') }, label)));
  sel.addEventListener('change', () => onChange(sel.value || null));
  return sel;
}

function input(type, value, onChange, opts = {}) {
  const i = el('input', { type, value: value == null ? '' : String(value), ...opts });
  i.addEventListener('input', () => onChange(i.value));
  return i;
}

function checkbox(checked, onChange, labelText) {
  const c = el('input', { type: 'checkbox' });
  if (checked) c.checked = true;
  c.addEventListener('change', () => onChange(c.checked));
  return el('label', { class: 'checkbox-row', style: 'display: inline-flex; gap: 6px; margin: 0;' }, [c, labelText]);
}

export async function renderProfile(view, ctx, playerId) {
  // Authz check at the API level — fetch and 401/403 if mine isn't.
  let player;
  try {
    player = (await api.get(`/api/v3/players/${playerId}`)).player;
  } catch (err) {
    view.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  // Local working copy
  const draft = { ...player };

  function commit(field, value) { draft[field] = value; }

  // Layout
  const layout = el('div', { class: 'profile-layout' });
  const mainCol = el('div', {});
  const sidebar = el('aside', { class: 'sidebar' });
  layout.appendChild(mainCol);
  layout.appendChild(sidebar);
  view.appendChild(layout);

  // ── Header ───────────────────────────────────────────────────
  const header = el('div', { class: 'profile-header' }, [
    el('div', { class: 'avatar-circle' }, initialsFor(player)),
    el('div', {}, [
      el('h1', { style: 'margin: 0;' }, player.name),
      el('div', { class: 'profile-id-row', style: 'margin-top: 6px;' }, [
        el('span', { class: 'player-code-chip' }, player.player_code || ''),
        el('span', { class: PROFILE_BADGES[player.profile_status]?.cls || 'badge' },
          PROFILE_BADGES[player.profile_status]?.label || player.profile_status),
        player.is_verified && player.verified_at
          ? el('span', { class: 'muted', style: 'font-size: 0.78rem;' },
              `verified ${fmtDate(player.verified_at)}`)
          : null,
      ]),
      el('p', { class: 'muted', style: 'margin-top: 4px; font-size: 0.78rem;' },
        'Photo upload coming soon'),
    ]),
  ]);
  mainCol.appendChild(header);

  // ── Personal section ─────────────────────────────────────────
  const categoryBox = el('div', { class: 'radio-row' });
  for (const [v, lab] of CATEGORIES.slice(1)) {
    const r = el('input', { type: 'radio', name: 'category', value: v });
    if ((draft.category || '') === v) r.checked = true;
    r.addEventListener('change', () => commit('category', v));
    categoryBox.appendChild(el('label', {}, [r, ' ' + lab]));
  }

  const personal = el('div', { class: 'profile-section' }, [
    el('h2', {}, 'Personal'),
    el('label', {}, 'Category'),
    categoryBox,
    el('div', { class: 'profile-grid', style: 'margin-top: 12px;' }, [
      labelled('First name',
        input('text', draft.first_name, (v) => commit('first_name', v))),
      labelled('Middle name',
        input('text', draft.middle_name, (v) => commit('middle_name', v))),
      labelled('Last name',
        input('text', draft.last_name, (v) => commit('last_name', v))),
      labelled('Display name',
        input('text', draft.display_name, (v) => commit('display_name', v))),
      labelled('Nationality',
        input('text', draft.nationality, (v) => commit('nationality', v))),
      labelled('Date of birth',
        input('date',
          draft.date_of_birth ? String(draft.date_of_birth).slice(0, 10) : '',
          (v) => commit('date_of_birth', v))),
      el('div', { class: 'field-full' },
        checkbox(!!draft.is_student, (v) => commit('is_student', v), 'I am currently a student')),
    ]),
  ]);
  mainCol.appendChild(personal);

  // ── Contact section ──────────────────────────────────────────
  const contact = el('div', { class: 'profile-section' }, [
    el('h2', {}, 'Contact'),
    el('div', { class: 'profile-grid' }, [
      labelled('Address line 1',
        input('text', draft.address_line1, (v) => commit('address_line1', v)), 'field-full'),
      labelled('Address line 2',
        input('text', draft.address_line2, (v) => commit('address_line2', v)), 'field-full'),
      labelled('City',
        input('text', draft.city, (v) => commit('city', v))),
      labelled('State / Region',
        input('text', draft.state_region, (v) => commit('state_region', v))),
      labelled('Country',
        input('text', draft.country, (v) => commit('country', v))),
      labelled('Postal code',
        input('text', draft.postal_code, (v) => commit('postal_code', v))),
      labelled('Registered email',
        input('email', draft.registered_email, (v) => commit('registered_email', v))),
      labelled('Phone number',
        input('text', draft.phone_number, (v) => commit('phone_number', v))),
      labelled('WhatsApp number',
        input('text', draft.whatsapp_number, (v) => commit('whatsapp_number', v))),
      labelled('Emergency contact name',
        input('text', draft.emergency_contact_name, (v) => commit('emergency_contact_name', v))),
      labelled('Emergency contact number',
        input('text', draft.emergency_contact_number, (v) => commit('emergency_contact_number', v))),
    ]),
  ]);
  mainCol.appendChild(contact);

  // ── Cricket section ──────────────────────────────────────────
  const cricket = el('div', { class: 'profile-section' }, [
    el('h2', {}, 'Cricket'),
    el('div', { class: 'profile-grid' }, [
      labelled('Role',
        selectEl(ROLES, draft.role, (v) => commit('role', v))),
      labelled('Batting style',
        selectEl(BATTING_STYLES, draft.batting_style, (v) => commit('batting_style', v))),
      labelled('Bowling style',
        selectEl(BOWLING_STYLES, draft.bowling_style, (v) => commit('bowling_style', v))),
      labelled('Bowling type',
        selectEl(BOWLING_TYPES, draft.bowling_type, (v) => commit('bowling_type', v))),
      el('div', { class: 'field-full' },
        checkbox(!!draft.is_certified_umpire, (v) => commit('is_certified_umpire', v),
          'I am a certified umpire')),
    ]),
  ]);
  mainCol.appendChild(cricket);

  // ── Save button ──────────────────────────────────────────────
  const errBox = el('div', { class: 'err' });
  const saveBtn = el('button', {
    class: 'btn',
    onClick: async () => {
      errBox.textContent = '';
      saveBtn.disabled = true;
      const original = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        const payload = {
          first_name: draft.first_name, middle_name: draft.middle_name,
          last_name: draft.last_name, display_name: draft.display_name,
          category: draft.category || null,
          nationality: draft.nationality,
          date_of_birth: draft.date_of_birth || null,
          is_student: !!draft.is_student,
          address_line1: draft.address_line1, address_line2: draft.address_line2,
          city: draft.city, state_region: draft.state_region,
          country: draft.country, postal_code: draft.postal_code,
          registered_email: draft.registered_email,
          phone_number: draft.phone_number, whatsapp_number: draft.whatsapp_number,
          emergency_contact_name: draft.emergency_contact_name,
          emergency_contact_number: draft.emergency_contact_number,
          batting_style: draft.batting_style || null,
          bowling_style: draft.bowling_style || null,
          bowling_type:  draft.bowling_type  || null,
          is_certified_umpire: !!draft.is_certified_umpire,
          role: draft.role || null,
        };
        await api.patch(`/api/v3/players/${playerId}/profile`, payload);
        toast('Profile saved', 'success');
      } catch (err) {
        errBox.textContent = err.message;
        toast(err.message, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = original;
      }
    },
  }, 'Save profile');

  mainCol.appendChild(el('div', { style: 'margin-top: 16px; display: flex; gap: 12px; align-items: center;' },
    [saveBtn, errBox]));

  // ── Sidebar: affiliated teams ────────────────────────────────
  sidebar.appendChild(el('h3', {}, 'Affiliated teams'));
  if ((ctx.players || []).length === 0) {
    sidebar.appendChild(el('p', { class: 'muted', style: 'font-size: 0.85rem;' }, 'None'));
  } else {
    for (const p of ctx.players) {
      sidebar.appendChild(el('div', { class: 'team-row' }, [
        el('div', { class: 'team-name' }, p.team_name),
        el('div', { class: 'team-tournament' }, p.tournament_name),
      ]));
    }
  }
}

function labelled(labelText, control, extraClass) {
  return el('div', { class: extraClass || '' }, [
    el('label', {}, labelText),
    control,
  ]);
}
