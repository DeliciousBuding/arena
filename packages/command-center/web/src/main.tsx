import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// 设计系统主体：复用 legacy 前端同一份 style.css（单一视觉源，防漂移）
import "../../public/style.css";
import "./styles/theme.css";

createRoot(document.getElementById("root")!).render(<App />);
