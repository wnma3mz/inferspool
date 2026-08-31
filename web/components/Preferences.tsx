"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Icon } from "./Icons";

export type Language = "zh" | "en";
export type Theme = "system" | "light" | "dark";

const PreferencesContext = createContext<
  {
    language: Language;
    setLanguage: (language: Language) => void;
    theme: Theme;
    setTheme: (theme: Theme) => void;
  } | null
>(null);

function applyTheme(theme: Theme) {
  const dark = theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>("zh");
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    const savedLanguage = localStorage.getItem("inferspool-language");
    const savedTheme = localStorage.getItem("inferspool-theme");
    if (savedLanguage === "zh" || savedLanguage === "en") {
      setLanguageState(savedLanguage);
    }
    if (
      savedTheme === "system" || savedTheme === "light" || savedTheme === "dark"
    ) setThemeState(savedTheme);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (theme === "system") applyTheme("system");
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  const setLanguage = (value: Language) => {
    setLanguageState(value);
    localStorage.setItem("inferspool-language", value);
  };
  const setTheme = (value: Theme) => {
    setThemeState(value);
    localStorage.setItem("inferspool-theme", value);
  };

  return (
    <PreferencesContext.Provider
      value={{ language, setLanguage, theme, setTheme }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) {
    throw new Error("usePreferences must be used inside PreferencesProvider");
  }
  return value;
}

export function PreferenceControls({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, theme, setTheme } = usePreferences();

  const nextLanguage: Language = language === "zh" ? "en" : "zh";
  const nextTheme: Theme = theme === "system"
    ? "light"
    : theme === "light"
    ? "dark"
    : "system";
  const themeLabel = theme === "system"
    ? (language === "zh" ? "跟随系统" : "System")
    : theme === "light"
    ? (language === "zh" ? "亮色" : "Light")
    : (language === "zh" ? "暗色" : "Dark");

  return (
    <div className={`preference-set ${compact ? "compact" : ""}`}>
      <button
        className="preference-trigger language-trigger"
        onClick={() => setLanguage(nextLanguage)}
        aria-label={language === "zh" ? "切换为英文" : "Switch to Chinese"}
      >
        <Icon name="globe" />
        <span>{language === "zh" ? "中文" : "English"}</span>
      </button>
      <div className="preference-controls">
        <button
          className="preference-trigger theme-trigger"
          onClick={() => setTheme(nextTheme)}
          aria-label={language === "zh"
            ? `显示主题：${themeLabel}，点击切换`
            : `Display theme: ${themeLabel}; click to switch`}
        >
          <Icon
            name={theme === "dark"
              ? "moon"
              : theme === "light"
              ? "sun"
              : "monitor"}
          />
          {!compact && <span>{themeLabel}</span>}
        </button>
      </div>
    </div>
  );
}
