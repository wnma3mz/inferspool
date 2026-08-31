"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className={`preference-controls ${compact ? "compact" : ""}`}
    >
      <button
        className="preference-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={language === "zh" ? "语言与主题" : "Language and theme"}
      >
        <Icon
          name={theme === "dark"
            ? "moon"
            : theme === "light"
            ? "sun"
            : "monitor"}
        />
        {!compact && (
          <span>{language === "zh" ? "偏好设置" : "Preferences"}</span>
        )}
        <Icon name="chevron" className={open ? "rotated" : ""} />
      </button>
      {open && (
        <div className="preference-menu" role="menu">
          <div className="preference-group">
            <span>
              <Icon name="globe" />
              {language === "zh" ? "界面语言" : "Language"}
            </span>
            <div className="choice-grid two">
              <button
                className={language === "zh" ? "active" : ""}
                onClick={() => setLanguage("zh")}
              >
                中文
              </button>
              <button
                className={language === "en" ? "active" : ""}
                onClick={() => setLanguage("en")}
              >
                English
              </button>
            </div>
          </div>
          <div className="preference-group">
            <span>
              <Icon name="sun" />
              {language === "zh" ? "显示主题" : "Theme"}
            </span>
            <div className="choice-grid three">
              <button
                className={theme === "system" ? "active" : ""}
                onClick={() => setTheme("system")}
              >
                <Icon name="monitor" />
                {language === "zh" ? "系统" : "System"}
              </button>
              <button
                className={theme === "light" ? "active" : ""}
                onClick={() => setTheme("light")}
              >
                <Icon name="sun" />
                {language === "zh" ? "浅色" : "Light"}
              </button>
              <button
                className={theme === "dark" ? "active" : ""}
                onClick={() => setTheme("dark")}
              >
                <Icon name="moon" />
                {language === "zh" ? "深色" : "Dark"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
