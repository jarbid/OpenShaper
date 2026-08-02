// SPDX-License-Identifier: GPL-3.0-or-later
import { FIN_PROFILE_LABELS, FIN_SETUP_LABELS, FIN_SYSTEM_LABELS } from '@openshaper/kernel';
import { DocsPage, Section, Term, Terms } from './DocsPage';

/**
 * Setups, systems and profiles are listed from the kernel's own label records, so
 * this page cannot list a setup the app doesn't have (or miss one it does). The
 * prose below still has to be written by hand — see docs/coverage.test.ts.
 */
export default function DocsFins() {
  return (
    <DocsPage
      route="/docs/fins"
      title="Fins"
      lede="Setups, mounting systems and blade profiles — and why fin placement follows the board rather than sitting at fixed coordinates."
      toc={[
        { id: 'parametric', label: 'How placement works' },
        { id: 'setups', label: 'Setups' },
        { id: 'systems', label: 'Systems' },
        { id: 'profiles', label: 'Profiles' },
        { id: 'exports', label: 'Fins in exports' },
      ]}
    >
      <Section id="parametric" title="How placement works">
        <p>
          A fin is not pinned to fixed coordinates. Its lateral position is an inset from the rail,
          and its base rides the bottom rocker surface — so when you change the outline or the
          profile, the fins move with the board, exactly as a shaper marks a blank relative to the
          rail and the tail.
        </p>
        <p>
          What is saved is the intent — the setup, the system, the specs — and the actual geometry
          is computed against the current shape whenever it is needed.
        </p>
      </Section>

      <Section id="setups" title="Setups">
        <p>How many fins, and where they sit.</p>
        <Terms>
          {Object.entries(FIN_SETUP_LABELS).map(([id, label]) => (
            <Term key={id} name={label}>
              {SETUP_NOTES[id] ?? 'Fin arrangement.'}
            </Term>
          ))}
        </Terms>
      </Section>

      <Section id="systems" title="Systems">
        <p>
          The mounting system determines the box or plug geometry routed into the board, which is
          what appears in the exports.
        </p>
        <Terms>
          {Object.entries(FIN_SYSTEM_LABELS).map(([id, label]) => (
            <Term key={id} name={label}>
              {SYSTEM_NOTES[id] ?? 'Mounting system.'}
            </Term>
          ))}
        </Terms>
      </Section>

      <Section id="profiles" title="Profiles">
        <p>Blade outline templates, used to draw and size the fin itself.</p>
        <Terms>
          {Object.entries(FIN_PROFILE_LABELS).map(([id, label]) => (
            <Term key={id} name={label}>
              {PROFILE_NOTES[id] ?? 'Blade template.'}
            </Term>
          ))}
        </Terms>
      </Section>

      <Section id="exports" title="Fins in exports">
        <p>
          Fin positions and box footprints carry through to the STL, the DXF and the 1:1 PDF, so the
          routing positions come out with the rest of the board rather than being marked separately.
        </p>
      </Section>
    </DocsPage>
  );
}

const SETUP_NOTES: Record<string, string> = {
  none: 'No fins — the default, and what every geometry calculation assumes unless you add them.',
  single: 'One centre fin. Longboards and classic single-fin shapes.',
  twin: 'Two side fins, no centre. Loose and fast through the flats.',
  thruster: 'Two side fins plus a centre fin. The default modern arrangement.',
  quad: 'Four fins, two per side, no centre.',
  '2+1': 'Two side fins plus a centre box — the longboard/mid-length convention.',
  '5-fin': 'Five boxes so the board can be ridden as a thruster or a quad.',
};

const SYSTEM_NOTES: Record<string, string> = {
  'glass-on': 'Fins laminated directly to the board. No box, so nothing is routed.',
  'fcs-ii': 'A continuous routed slot per fin.',
  'fcs-x2': 'Two round plugs per fin, about 3″ centre to centre.',
  futures: 'One continuous box per fin, deeper on the sides than the centre.',
};

const PROFILE_NOTES: Record<string, string> = {
  thruster: 'Upright, moderate rake — the general-purpose modern template.',
  single: 'Larger, more raked centre-fin outline.',
  noserider: 'Deep, heavily raked longboard fin for holding a nose ride.',
  keel: 'Short, long-based swept fin for fish and twin setups.',
};
