import { useEffect } from "react";
import { useTitleContext } from "@/contexts/TitleContext";

export function usePageTitle(title: string) {
  const { setPageTitle } = useTitleContext();
  useEffect(() => {
    setPageTitle(title);
    return () => { setPageTitle(""); };
  }, [title, setPageTitle]);
}
