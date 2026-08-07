import { useState } from "react";
import { MapHost } from "./components/MapHost";
import { TopBar } from "./components/TopBar";
import { StreamPane } from "./components/StreamPane";
import { IntelDialog, RedeemDialog } from "./components/Dialogs";

export default function App() {
  const [intelOpen, setIntelOpen] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  return (
    <>
      <TopBar onIntel={() => setIntelOpen(true)} onRedeem={() => setRedeemOpen(true)} />
      <MapHost />
      <StreamPane />
      <IntelDialog open={intelOpen} onClose={() => setIntelOpen(false)} />
      <RedeemDialog open={redeemOpen} onClose={() => setRedeemOpen(false)} />
    </>
  );
}
