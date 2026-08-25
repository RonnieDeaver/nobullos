/**
 * TitleContext — holds the current page-specific title fragment so that
 * GlobalTitleManager (in App.tsx) can compose and write the final
 * `document.title` in one place, including unread-count badges.
 *
 * Usage:
 *  - Pages / components call `usePageTitle("My Page")` (unchanged API).
 *  - GlobalTitleManager reads `pageTitle` from this context and combines it
 *    with bell + chat counts before writing `document.title`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

interface TitleContextValue {
  pageTitle: string;
  setPageTitle: (title: string) => void;
}

const TitleContext = createContext<TitleContextValue>({
  pageTitle: "",
  setPageTitle: () => {},
});

export function TitleProvider({ children }: { children: ReactNode }) {
  const [pageTitle, setPageTitleState] = useState("");

  const setPageTitle = useCallback((title: string) => {
    setPageTitleState(title);
  }, []);

  const value = useMemo(() => ({ pageTitle, setPageTitle }), [pageTitle, setPageTitle]);

  return <TitleContext.Provider value={value}>{children}</TitleContext.Provider>;
}

export function useTitleContext(): TitleContextValue {
  return useContext(TitleContext);
}
