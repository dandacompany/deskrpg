import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const screenshot = await readFile(join(process.cwd(), "public/readme/home-screenshot.png"));
  const screenshotUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  const mark = await readFile(join(process.cwd(), "public/assets/brand/deskrpg-icon-96.png"));
  const markUrl = `data:image/png;base64,${mark.toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        overflow: "hidden",
        background: "#eff7f1",
      }}
    >
      {/* Keep the real product capture and cover only the login form area with brand copy. */}
      <img
        src={screenshotUrl}
        alt=""
        style={{ position: "absolute", left: 0, top: -25, width: 1200, height: 675 }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: 100,
          height: 32,
          background: "#eff7f1",
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 525,
          height: 630,
          background: "#eff7f1",
          display: "flex",
          flexDirection: "column",
          padding: "62px 55px 50px 65px",
          borderRight: "1px solid #d9e7dd",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", color: "#234638" }}>
          <img src={markUrl} alt="" width={48} height={48} style={{ borderRadius: 13 }} />
          <span style={{ fontSize: 32, fontWeight: 800, marginLeft: 12 }}>DeskRPG</span>
          <span style={{ fontSize: 20, marginLeft: 10, color: "#526b5e" }}>for Hermes</span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 95,
            color: "#214636",
            lineHeight: 1.1,
          }}
        >
          <span style={{ fontSize: 62, fontWeight: 800 }}>YOUR AI</span>
          <span style={{ fontSize: 62, fontWeight: 800 }}>COWORKERS</span>
          <span style={{ fontSize: 31, marginTop: 22, color: "#587367" }}>
            in a 3D virtual office
          </span>
        </div>
        <div style={{ display: "flex", marginTop: "auto", color: "#446253", fontSize: 22 }}>
          Talk · Meet · Work together
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 32,
          bottom: 26,
          display: "flex",
          padding: "9px 16px",
          color: "#fff",
          background: "#214636",
          borderRadius: 5,
          fontSize: 19,
        }}
      >
        deskrpg.com
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: { "Cache-Control": "public, max-age=3600" },
    },
  );
}
