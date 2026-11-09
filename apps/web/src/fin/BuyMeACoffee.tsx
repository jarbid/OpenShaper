// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin designer's Buy Me a Coffee link (owner request): the owner's own artwork beside
 * two lines of text in the app's font. A plain link rather than Buy Me a Coffee's widget,
 * so no third-party script runs in the app and nothing is sent until someone clicks it.
 */

const CUP = '#5CBED7';
const STEAM = '#C9D2DF';
const SPARK = '#E87B35';

export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/stephenfranklin';

export function BuyMeACoffee() {
  return (
    <a
      href={BUY_ME_A_COFFEE_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Buy me a coffee (opens in a new tab)"
      className="flex min-h-9 items-center gap-1.5 rounded-md px-2 hover:bg-muted"
    >
      <svg viewBox="126.7 54 9 6.8" className="h-7 w-auto" aria-hidden="true">
        <g fill="none" stroke={CUP} strokeWidth="0.33946">
          <ellipse cx="131.25757" cy="55.965569" rx="2.4936543" ry="0.71525276" />
          <path d="m 128.93757,57.995272 c -0.99051,0.274336 -1.57532,0.706661 -1.57771,1.166366 -5e-5,0.804744 1.75169,1.457128 3.91259,1.457126 2.16089,2e-6 3.91263,-0.652382 3.91258,-1.457126 -2e-4,-0.45831 -0.57943,-0.889875 -1.56362,-1.165025" />
          <path d="m 128.78036,57.155587 -0.005,-1.104611" />
          <path d="M 133.74522,57.155587 V 56.009848" />
          <path d="m 133.70145,56.417604 c 0,0 0.31747,-0.382055 0.71052,-0.04585 0.39303,0.336208 0.30233,0.993337 -0.0906,1.360109 -0.39303,0.36677 -0.81634,0.229237 -0.81634,0.229237" />
          <path d="m 133.73963,57.156367 c -0.002,1.139656 -0.96329,2.057143 -2.15986,2.057143 h -0.63918 c -1.19657,0 -2.15987,-0.917485 -2.15987,-2.057143" />
        </g>
        <path d="m 127.0762,56.810958 3.90409,-2.467752" stroke={STEAM} strokeWidth="0.177006" />
        <circle
          cx="129.05705"
          cy="55.518612"
          r="0.23343188"
          fill={STEAM}
          stroke={SPARK}
          strokeWidth="0.312358"
        />
        <circle
          cx="131.10916"
          cy="54.260487"
          r="0.11642234"
          fill={STEAM}
          stroke={STEAM}
          strokeWidth="0.260212"
        />
        <circle
          cx="126.96083"
          cy="56.899693"
          r="0.11642234"
          fill={STEAM}
          stroke={STEAM}
          strokeWidth="0.260212"
        />
      </svg>
      <span className="text-[11px] font-medium leading-[1.1] text-foreground">
        Buy me
        <br />a coffee
      </span>
    </a>
  );
}
