/** 主题分支入口。AppearanceProvider 在同一组件树切换外观，保留草稿与预览；正式主题覆盖在共用基础样式之后加载。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AppearanceProvider } from "./Appearance.tsx";
import "./styles.css";
import "./responsive.css";
import "./revamp.css";
import "./formal.css";
import "./hunt-side.css";
import "./HuntGallery.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppearanceProvider><App /></AppearanceProvider>
  </React.StrictMode>,
);
