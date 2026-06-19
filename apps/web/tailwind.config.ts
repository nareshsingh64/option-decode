import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "rgb(var(--terminal-bg) / <alpha-value>)",
          panel: "rgb(var(--terminal-panel) / <alpha-value>)",
          input: "rgb(var(--terminal-input) / <alpha-value>)",
          line: "rgb(var(--terminal-line) / <alpha-value>)",
          text: "rgb(var(--terminal-text) / <alpha-value>)",
          muted: "rgb(var(--terminal-muted) / <alpha-value>)",
          blue: "rgb(var(--terminal-blue) / <alpha-value>)",
          emerald: "rgb(var(--terminal-emerald) / <alpha-value>)",
          amber: "rgb(var(--terminal-amber) / <alpha-value>)",
          red: "rgb(var(--terminal-red) / <alpha-value>)"
        }
      }
    }
  },
  plugins: []
};

export default config;
