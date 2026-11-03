/** 主题分支默认原版；显式保存的正式版偏好继续有效。主题只改变外观，不重新挂载页面、草稿或预览；存储不可用时当前会话仍可使用。 */
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

export type Appearance = 'formal' | 'original';
const key = 'wechatbot.appearance';
/** 惰性读取浏览器偏好：只有明确存为 formal 才启用正式版，缺失或读取失败均使用原版。 */
function readAppearance(): Appearance {
  try {
    return localStorage.getItem(key) === 'formal' ? 'formal' : 'original';
  } catch {
    return 'original';
  }
}
const AppearanceContext = createContext<{
  appearance: Appearance;
  setAppearance: (value: Appearance) => void;
}>({ appearance: 'original', setAppearance: () => {} });
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  useLayoutEffect(() => {
    document.documentElement.dataset.ui = appearance;
    try {
      localStorage.setItem(key, appearance);
    } catch {
      /* The current session still works with storage disabled. */
    }
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', appearance === 'formal' ? '#e7e0d5' : '#26324d');
  }, [appearance]);
  return (
    <AppearanceContext.Provider value={{ appearance, setAppearance }}>
      {children}
    </AppearanceContext.Provider>
  );
}
export const useAppearance = () => useContext(AppearanceContext);
