/** 正式版入口。文档 data-ui 固定主题，不读取旧外观偏好；正式主题在共享基础样式后加载。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./responsive.css";
import "./revamp.css";
import "./formal.css";
import "./hunt-side.css";
import "./HuntGallery.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
