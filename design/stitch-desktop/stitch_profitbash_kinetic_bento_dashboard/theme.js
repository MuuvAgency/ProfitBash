/* ProfitBash — Kinetic Bento shared design tokens (single source of truth).
   Included after the Tailwind Play CDN in every screen. Edit tokens HERE, not per-screen. */
tailwind.config = {
    darkMode: "class",
    theme: {
      extend: {
        "colors": {
          "tile-peak": "#FFFFFF",
          "ink-on-dark": "#EDECF3",
          "surface-dim": "#ddd8e4",
          "on-tertiary": "#ffffff",
          "on-error-container": "#93000a",
          "primary": "#4227b1",
          "on-surface-variant": "#484554",
          "surface": "#fdf8ff",
          "warn-amber": "#E0A233",
          "tertiary": "#6e3300",
          "inverse-on-surface": "#f4effa",
          "secondary-container": "#c4ef3e",
          "ink-secondary": "#63607A",
          "well-sunken": "#E6E4EC",
          "on-primary-container": "#d6ceff",
          "on-error": "#ffffff",
          "surface-container": "#f1ecf8",
          "on-tertiary-fixed-variant": "#733600",
          "on-secondary-fixed": "#161f00",
          "on-primary": "#ffffff",
          "inverse-surface": "#312f38",
          "lime-deep": "#7E9E12",
          "tertiary-container": "#924600",
          "violet-press": "#4835A6",
          "surface-tint": "#5d47cc",
          "surface-container-lowest": "#ffffff",
          "surface-container-highest": "#e5e0ec",
          "surface-container-low": "#f7f1fd",
          "inverse-primary": "#c8bfff",
          "background": "#fdf8ff",
          "outline": "#787585",
          "ink-primary": "#1B1826",
          "outline-variant": "#c9c4d6",
          "on-surface": "#1c1b23",
          "primary-fixed": "#e5deff",
          "tile-raise": "#FAFAFC",
          "on-background": "#1c1b23",
          "on-tertiary-container": "#ffc8a7",
          "ink-panel": "#1B1826",
          "on-secondary-container": "#546b00",
          "error": "#ba1a1a",
          "secondary": "#506600",
          "surface-bright": "#fdf8ff",
          "primary-fixed-dim": "#c8bfff",
          "secondary-fixed-dim": "#acd522",
          "primary-container": "#5a44c9",
          "on-secondary-fixed-variant": "#3c4d00",
          "on-primary-fixed-variant": "#452bb3",
          "surface-variant": "#e5e0ec",
          "violet-wash": "#ECE8FA",
          "on-secondary": "#ffffff",
          "tertiary-fixed": "#ffdbc7",
          "canvas-mist": "#EEEDF3",
          "ink-tertiary": "#9C99AD",
          "on-tertiary-fixed": "#311300",
          "on-primary-fixed": "#1a0064",
          "whisper-line": "rgba(27,24,38,0.06)",
          "error-container": "#ffdad6",
          "tertiary-fixed-dim": "#ffb688",
          "surface-container-high": "#ebe6f2",
          "secondary-fixed": "#c7f241",
          "loss-red": "#D6524B"
        },
        "borderRadius": {
          "DEFAULT": "0.25rem",
          "lg": "0.5rem",
          "xl": "0.75rem",
          "full": "9999px"
        },
        "spacing": {
          "margin": "1.5rem",
          "margin-mobile": "1rem",
          "space-lg": "1.25rem",
          "space-xl": "1.75rem",
          "gutter": "1.25rem",
          "space-xs": "0.25rem",
          "gutter-mobile": "0.75rem",
          "space-md": "1rem",
          "space-sm": "0.5rem"
        },
        "fontFamily": {
          "headline-lg-mobile": [
            "Space Grotesk"
          ],
          "body-lg": [
            "Space Grotesk"
          ],
          "headline-lg": [
            "Space Grotesk"
          ],
          "label-eyebrow": [
            "Space Grotesk"
          ],
          "display": [
            "Space Grotesk"
          ],
          "data-lg": [
            "JetBrains Mono"
          ],
          "headline-md": [
            "Space Grotesk"
          ],
          "data-sm": [
            "JetBrains Mono"
          ],
          "body-md": [
            "Space Grotesk"
          ],
          "data-hero-mobile": [
            "JetBrains Mono"
          ],
          "display-mobile": [
            "Space Grotesk"
          ],
          "body-sm": [
            "Space Grotesk"
          ],
          "headline-sm": [
            "Space Grotesk"
          ],
          "data-md": [
            "JetBrains Mono"
          ],
          "data-hero": [
            "JetBrains Mono"
          ]
        },
        "fontSize": {
          "headline-lg-mobile": [
            "22px",
            {
              "lineHeight": "28px",
              "letterSpacing": "-0.01em",
              "fontWeight": "700"
            }
          ],
          "body-lg": [
            "16px",
            {
              "lineHeight": "24px",
              "letterSpacing": "0em",
              "fontWeight": "400"
            }
          ],
          "headline-lg": [
            "30px",
            {
              "lineHeight": "34px",
              "letterSpacing": "-0.02em",
              "fontWeight": "700"
            }
          ],
          "label-eyebrow": [
            "11px",
            {
              "lineHeight": "14px",
              "letterSpacing": "0.06em",
              "fontWeight": "700"
            }
          ],
          "display": [
            "52px",
            {
              "lineHeight": "52px",
              "letterSpacing": "-0.03em",
              "fontWeight": "700"
            }
          ],
          "data-lg": [
            "22px",
            {
              "lineHeight": "26px",
              "letterSpacing": "0em",
              "fontWeight": "600"
            }
          ],
          "headline-md": [
            "20px",
            {
              "lineHeight": "26px",
              "letterSpacing": "-0.01em",
              "fontWeight": "600"
            }
          ],
          "data-sm": [
            "12px",
            {
              "lineHeight": "16px",
              "letterSpacing": "0em",
              "fontWeight": "500"
            }
          ],
          "body-md": [
            "14px",
            {
              "lineHeight": "21px",
              "letterSpacing": "0em",
              "fontWeight": "400"
            }
          ],
          "data-hero-mobile": [
            "26px",
            {
              "lineHeight": "30px",
              "letterSpacing": "-0.01em",
              "fontWeight": "700"
            }
          ],
          "display-mobile": [
            "32px",
            {
              "lineHeight": "36px",
              "letterSpacing": "-0.02em",
              "fontWeight": "700"
            }
          ],
          "body-sm": [
            "13px",
            {
              "lineHeight": "18px",
              "letterSpacing": "0em",
              "fontWeight": "400"
            }
          ],
          "headline-sm": [
            "18px",
            {
              "lineHeight": "22px",
              "letterSpacing": "0em",
              "fontWeight": "600"
            }
          ],
          "data-md": [
            "14px",
            {
              "lineHeight": "20px",
              "letterSpacing": "0em",
              "fontWeight": "500"
            }
          ],
          "data-hero": [
            "42px",
            {
              "lineHeight": "40px",
              "letterSpacing": "-0.02em",
              "fontWeight": "700"
            }
          ]
        }
      },
    },
  }
