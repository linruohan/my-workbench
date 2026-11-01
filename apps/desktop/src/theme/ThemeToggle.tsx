import { IconMoon, IconSun } from "../shell/icons";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { label, cycleMode, resolved } = useTheme();
  return (
    <button
      type="button"
      className="titlebar__btn"
      onClick={cycleMode}
      aria-label={`主题：${label}，点击切换`}
      title={`主题：${label}`}
      data-resolved={resolved}
    >
      {resolved === "dark" ? <IconMoon size={15} /> : <IconSun size={15} />}
    </button>
  );
}
