import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// 设计系统主体：复用 legacy 前端同一份 style.css（单一视觉源，防漂移）
import "../../public/style.css";
import "./styles/theme.css";
// Tailwind v4 + token 桥接层（@theme inline 把 shadcn 语义变量映射到 style.css 的 :root）
import "./styles/tailwind.css";

createRoot(document.getElementById("root")!).render(<App />);
