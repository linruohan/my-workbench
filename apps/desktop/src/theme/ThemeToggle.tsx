import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { label, cycleMode, resolved } = useTheme();
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycleMode}
      aria-label={`主题：${label}，点击切换`}
      title={`主题：${label}`}
      data-resolved={resolved}
    >
      主题 · {label}
    </button>
  );
}
