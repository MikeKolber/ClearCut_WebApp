"""Generate an interactive 3D HTML rocket viewer using Three.js.

Reads geometry data from ``rocket_data.json`` (written by ``generate_sketch``)
and produces a self-contained HTML file that can be opened in any modern browser.
"""

import base64
import json
import webbrowser
from pathlib import Path

SKETCH_DIR = Path(__file__).resolve().parent
ASSETS_DIR = SKETCH_DIR.resolve().parent.parent / "assets"


def _load_logo_b64():
    logo_path = ASSETS_DIR / "logo1.png"
    if logo_path.exists():
        return base64.b64encode(logo_path.read_bytes()).decode("ascii")
    return ""


def _logo_aspect():
    """Return width/height of the logo image."""
    import struct
    logo_path = ASSETS_DIR / "logo1.png"
    if not logo_path.exists():
        return 4.0
    raw = logo_path.read_bytes()
    w, h = struct.unpack(">II", raw[16:24])
    return w / h if h else 4.0


def _load_flag_b64():
    flag_path = ASSETS_DIR / "israel_flag_dark.jpg"
    if flag_path.exists():
        return base64.b64encode(flag_path.read_bytes()).decode("ascii")
    return ""


def _flag_aspect():
    """Return width/height of the flag image."""
    from PIL import Image
    flag_path = ASSETS_DIR / "israel_flag_dark.jpg"
    if not flag_path.exists():
        return 1.5
    img = Image.open(flag_path)
    w, h = img.size
    return w / h if h else 1.5


def generate_3d_html(data=None):
    """Build the 3D HTML viewer and return the output path.

    If *data* is ``None``, reads from ``rocket_data.json`` on disk.
    Returns ``None`` when no data is available.
    """
    if data is None:
        json_path = SKETCH_DIR / "rocket_data.json"
        if not json_path.exists():
            return None
        data = json.loads(json_path.read_text())

    logo_b64 = _load_logo_b64()
    flag_b64 = _load_flag_b64()
    html = _HTML_TEMPLATE.replace("__ROCKET_DATA__", json.dumps(data, indent=2))
    html = html.replace("__LOGO_B64__", logo_b64)
    html = html.replace("__LOGO_ASPECT__", f"{_logo_aspect():.4f}")
    html = html.replace("__FLAG_B64__", flag_b64)
    html = html.replace("__FLAG_ASPECT__", f"{_flag_aspect():.4f}")
    out = SKETCH_DIR / "rocket_structure_3d.html"
    out.write_text(html)
    return out


def open_3d_viewer():
    """Generate the HTML and open it in the default browser."""
    path = generate_3d_html()
    if path is not None:
        webbrowser.open(path.as_uri())
    return path


# ─────────────────────────────────────────────────────────────────────
#  HTML template  (Three.js r160 via unpkg CDN)
# ─────────────────────────────────────────────────────────────────────

_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClearCut — 3D Rocket Structure</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050510;overflow:hidden;
     font-family:-apple-system,BlinkMacSystemFont,'SF Pro','Segoe UI',system-ui,sans-serif}
canvas{display:block}

#title{position:absolute;top:20px;left:50%;transform:translateX(-50%);
       color:#e0e0f0;font-size:18px;font-weight:600;letter-spacing:.6px;
       text-shadow:0 2px 12px rgba(0,0,0,.7);pointer-events:none}

#legend{position:absolute;bottom:22px;left:22px;
        background:rgba(8,8,22,.85);backdrop-filter:blur(14px);
        border:1px solid rgba(255,255,255,.06);border-radius:14px;
        padding:14px 18px;color:#b0b0c0;font-size:11.5px;line-height:2}
.lr{display:flex;align-items:center;gap:10px}
.sw{width:12px;height:12px;border-radius:3px;
    border:1px solid rgba(255,255,255,.1);flex-shrink:0}

#hint{position:absolute;bottom:24px;right:22px;
      color:rgba(255,255,255,.25);font-size:10.5px;text-align:right;line-height:1.7}

.topBtn{position:absolute;top:20px;
        background:rgba(8,8,22,.65);backdrop-filter:blur(10px);
        border:1px solid rgba(255,255,255,.08);border-radius:8px;
        color:#999;font-size:11px;padding:6px 14px;cursor:pointer;
        transition:all .2s}
.topBtn:hover{background:rgba(25,25,55,.8);color:#ddd}
#autoBtn{right:22px}
#tiltBtn{right:160px}
#vignette{position:fixed;top:0;left:0;width:100%;height:100%;
  pointer-events:none;
  background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,0.4) 100%)}
#focusWrap{position:absolute;left:16px;top:80px;height:40vh;
  display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:10px 6px;
  background:rgba(8,8,22,.65);backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.08);border-radius:10px}
#focusLabel{color:rgba(255,255,255,.35);font-size:9px;letter-spacing:1px}
#focusSlider{
  writing-mode:vertical-lr;direction:rtl;
  -webkit-appearance:none;appearance:none;
  width:3px;flex:1;background:rgba(255,255,255,.1);
  border-radius:2px;outline:none;cursor:pointer;margin:0}
#focusSlider::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;
  width:14px;height:14px;border-radius:50%;
  background:rgba(140,150,190,.5);border:1px solid rgba(255,255,255,.15);
  cursor:pointer;transition:background .2s}
#focusSlider::-webkit-slider-thumb:hover{background:rgba(170,180,220,.7)}
#focusSlider::-moz-range-thumb{
  width:14px;height:14px;border-radius:50%;border:1px solid rgba(255,255,255,.15);
  background:rgba(140,150,190,.5);cursor:pointer}
</style>
<script type="importmap">
{
  "imports":{
    "three":"https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"
  }
}
</script>
</head>
<body>

<div id="title">ClearCut &mdash; 3D Rocket Structure</div>
<div id="vignette"></div>

<div id="legend">
  <div class="lr"><span class="sw" style="background:#1a1a1a"></span>Nozzle</div>
  <div class="lr"><span class="sw" style="background:#3a3a42"></span>Engine</div>
  <div class="lr"><span class="sw" style="background:#E8860C"></span>Fuel</div>
  <div class="lr"><span class="sw" style="background:#87CEEB"></span>Oxidizer</div>
  <div class="lr"><span class="sw" style="background:#B0B0B0"></span>Tank Heads</div>
  <div class="lr"><span class="sw" style="background:#808088"></span>Interstage</div>
  <div class="lr"><span class="sw" style="background:#C9A55A"></span>Payload</div>
  <div class="lr"><span class="sw" style="background:rgba(220,220,230,.5)"></span>Fairing</div>
  <div class="lr"><span class="sw" style="background:#666"></span>Fins</div>
</div>

<div id="hint">
  Drag to rotate &bull; Scroll to zoom<br>Right-drag to pan
</div>

<button id="autoBtn" class="topBtn" onclick="toggleSpin()">Pause rotation</button>
<button id="tiltBtn" class="topBtn" onclick="toggleTilt()">Horizontal view</button>

<div id="focusWrap">
  <span id="focusLabel">FOCUS</span>
  <input id="focusSlider" type="range" min="0" max="100" value="52" orient="vertical">
</div>

<script type="module">
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const D = __ROCKET_DATA__;

const TW=0.95, EW=0.8, GAP=0.1, SEG=64;

const C={
  engine:  0x3a3a42,
  fuel:    0xE8860C,
  ox:      0x87CEEB,
  head:    0xB0B0B0,
  inter:   0x808088,
  payload: 0xC9A55A,
  fairing: 0xDCDCE6,
  wall:    0xCCCCD0,
  nozzle:  0x1a1a1a,
  fin:     0x666666,
  ring:    0x222228,
  nose:    0xE0E0E8,
};

/* ── materials ── */
function mat(color,o={}){
  const isTransparent = o.alpha!=null;
  const props = {
    color,
    roughness:   o.rough ?? 0.45,
    metalness:   o.metal ?? 0.15,
    clearcoat:   o.coat  ?? 0,
    clearcoatRoughness: o.coatR ?? 0.25,
    transparent: isTransparent,
    opacity:     o.alpha ?? 1,
    depthWrite:  !isTransparent,
    side: o.double?THREE.DoubleSide:THREE.FrontSide,
  };
  if(isTransparent && o.double){
    props.emissive=color;
    props.emissiveIntensity=0.1;
  }
  return new THREE.MeshPhysicalMaterial(props);
}

function sk(n,k){return D['stage'+n+'_'+k];}

/* ───────────────── geometry helpers ───────────────── */

function addCyl(g,r,h,y,c,o){
  const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,SEG),mat(c,o||{}));
  m.position.y=y+h/2; g.add(m); return y+h;
}

function addCone(g,rT,rB,h,y,c,o){
  const m=new THREE.Mesh(new THREE.CylinderGeometry(rT,rB,h,SEG),mat(c,o||{}));
  m.position.y=y+h/2; g.add(m); return y+h;
}

function addDomeUp(g,r,h,y,c,o){
  const geo=new THREE.SphereGeometry(r,SEG,SEG/2,0,Math.PI*2,0,Math.PI/2);
  const m=new THREE.Mesh(geo,mat(c,o||{})); m.scale.y=h/r; m.position.y=y;
  g.add(m); return y+h;
}

function addDomeDown(g,r,h,y,c,o){
  const geo=new THREE.SphereGeometry(r,SEG,SEG/2,0,Math.PI*2,Math.PI/2,Math.PI/2);
  const m=new THREE.Mesh(geo,mat(c,o||{})); m.scale.y=h/r; m.position.y=y+h;
  g.add(m); return y+h;
}

function addSphere(g,r,cy,c,o){
  const m=new THREE.Mesh(new THREE.SphereGeometry(r,SEG,SEG),mat(c,o||{}));
  m.position.y=cy; g.add(m);
}

function addWall(g,r,h,y){
  const geo=new THREE.CylinderGeometry(r,r,h,SEG,1,true);
  const m=new THREE.Mesh(geo,mat(C.wall,{alpha:0.18,double:true,rough:0.3,coat:0.2}));
  m.position.y=y+h/2; g.add(m);
}

/* ── engine nozzle bell ── */
function addNozzle(g,y,stageR,engLen){
  const tR=stageR*EW*0.28;
  const eR=stageR*EW*0.88;
  const len=engLen*0.45;
  const pts=[];
  for(let i=0;i<=24;i++){
    const t=i/24;
    const r=tR+(eR-tR)*Math.pow(t,0.52);
    pts.push(new THREE.Vector2(r,-t*len));
  }
  const geo=new THREE.LatheGeometry(pts,SEG);
  const m=new THREE.Mesh(geo,mat(C.nozzle,{metal:0.85,rough:0.12,coat:0.6,double:true}));
  m.position.y=y; g.add(m);

  /* combustion chamber */
  const chR=tR*0.9, chH=engLen*0.18;
  const ch=new THREE.Mesh(new THREE.CylinderGeometry(chR,chR*1.1,chH,24),
    mat(0x2a2a30,{metal:0.9,rough:0.1,coat:0.5}));
  ch.position.y=y+chH*0.3; g.add(ch);

  /* gimbal ring */
  const gimR=tR*1.15;
  const gim=new THREE.Mesh(new THREE.TorusGeometry(gimR,gimR*0.06,8,SEG),
    mat(0x444450,{metal:0.8,rough:0.15}));
  gim.rotation.x=Math.PI/2; gim.position.y=y+0.01; g.add(gim);

  /* inner glow ring */
  const glow=new THREE.Mesh(
    new THREE.TorusGeometry(eR*0.85,eR*0.08,12,SEG),
    new THREE.MeshBasicMaterial({color:0x662200})
  );
  glow.rotation.x=Math.PI/2;
  glow.position.y=y-len;
  g.add(glow);

  /* exhaust plume */
  const plH=engLen*0.5, exitY=y-len;
  const cGeo=new THREE.ConeGeometry(eR*0.3,plH*0.5,24,1,true);
  const cM=new THREE.Mesh(cGeo,new THREE.MeshBasicMaterial({
    color:0xff8833,transparent:true,opacity:0.12,side:THREE.DoubleSide,depthWrite:false}));
  cM.position.y=exitY-plH*0.25; g.add(cM);
  const oGeo=new THREE.ConeGeometry(eR*0.7,plH,24,1,true);
  const oM=new THREE.Mesh(oGeo,new THREE.MeshBasicMaterial({
    color:0xff4400,transparent:true,opacity:0.04,side:THREE.DoubleSide,depthWrite:false}));
  oM.position.y=exitY-plH*0.5; g.add(oM);

  /* turbopump exhaust pipe */
  const pipeA=Math.PI*0.75;
  const pipePts=[];
  for(let i=0;i<=16;i++){
    const t=i/16;
    const pr=tR+(eR-tR)*Math.pow(t,0.52)+eR*0.08;
    pipePts.push(new THREE.Vector3(Math.cos(pipeA)*pr,y-t*len,Math.sin(pipeA)*pr));
  }
  const pipePath=new THREE.CatmullRomCurve3(pipePts);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(pipePath,16,stageR*0.01,6,false),
    mat(0x555560,{metal:0.7,rough:0.2})));
}

/* ── nose cone (ogive) ── */
function addNoseCone(g,baseY,baseR,length){
  const pts=[];
  for(let i=0;i<=32;i++){
    const t=i/32;
    const r=baseR*Math.pow(1-t*0.97,0.55);
    pts.push(new THREE.Vector2(Math.max(r,0.002),t*length));
  }
  pts.push(new THREE.Vector2(0.001,length));
  const geo=new THREE.LatheGeometry(pts,SEG);
  const m=new THREE.Mesh(geo,mat(C.nose,{rough:0.3,coat:0.5,coatR:0.15}));
  m.position.y=baseY; g.add(m);
}

/* ── fins (delta) ── */
function addFins(g,baseY,R,numFins,engLen){
  const root=engLen*0.9;
  const span=R*0.55;
  const tip=root*0.2;
  const sw=root*0.5;
  const thick=R*0.025;

  const shape=new THREE.Shape();
  shape.moveTo(R*0.98,0);
  shape.lineTo(R*0.98,root);
  shape.lineTo(R+span,sw+tip);
  shape.lineTo(R+span,sw);
  shape.closePath();

  const geo=new THREE.ExtrudeGeometry(shape,{depth:thick,bevelEnabled:true,
    bevelThickness:thick*0.3,bevelSize:thick*0.3,bevelSegments:2});
  const finMat=mat(C.fin,{metal:0.55,rough:0.2,coat:0.4});

  for(let i=0;i<numFins;i++){
    const mesh=new THREE.Mesh(geo,finMat);
    mesh.position.z=-thick/2;
    const piv=new THREE.Group();
    piv.add(mesh);
    piv.rotation.y=(i/numFins)*Math.PI*2;
    piv.position.y=baseY;
    g.add(piv);
  }
}


/* ── panel ring (seam line) ── */
function addRing(g,y,r){
  const geo=new THREE.TorusGeometry(r+0.002,r*0.008,8,SEG);
  const m=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:C.ring}));
  m.rotation.x=Math.PI/2; m.position.y=y; g.add(m);
}

/* ── RCS thruster pods ── */
function addRCSPods(g,y,R,num){
  const podR=R*0.04, podL=R*0.12;
  const pMat=mat(0x888888,{metal:0.7,rough:0.2});
  const nMat=mat(0x333333,{metal:0.5,rough:0.3});
  for(let i=0;i<num;i++){
    const a=(i/num)*Math.PI*2;
    const pod=new THREE.Group();
    const body=new THREE.Mesh(new THREE.BoxGeometry(podL,podR*2,podR*2),pMat);
    pod.add(body);
    const noz=new THREE.Mesh(new THREE.CylinderGeometry(podR*0.4,podR*0.7,podL*0.25,8),nMat);
    noz.rotation.z=Math.PI/2; noz.position.x=podL*0.55; pod.add(noz);
    pod.position.set(Math.cos(a)*(R+podL*0.4),y,Math.sin(a)*(R+podL*0.4));
    pod.rotation.y=-a; g.add(pod);
  }
}

/* ── vertical stringers ── */
function addStringers(g,baseY,h,R,num){
  const lMat=new THREE.LineBasicMaterial({color:0x333340,transparent:true,opacity:0.25});
  for(let i=0;i<num;i++){
    const a=(i/num)*Math.PI*2;
    const cx=Math.cos(a)*R, cz=Math.sin(a)*R;
    const pts=[new THREE.Vector3(cx,baseY,cz),new THREE.Vector3(cx,baseY+h,cz)];
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),lMat));
  }
}

/* ── external conduit ── */
function addConduit(g,baseY,h,R,angle){
  const r=R*0.015;
  const cx=Math.cos(angle)*R, cz=Math.sin(angle)*R;
  const path=new THREE.LineCurve3(new THREE.Vector3(cx,baseY,cz),new THREE.Vector3(cx,baseY+h,cz));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(path,1,r,8,false),mat(0x666677,{metal:0.6,rough:0.3})));
}

/* ── payload antenna ── */
function addAntenna(g,y,R,angle){
  const a=angle!=null?angle:Math.PI/2;
  const bH=R*0.14, rH=R*0.7, rR=R*0.022;
  const ax=Math.cos(a)*R*0.7, az=Math.sin(a)*R*0.7;
  const base=new THREE.Mesh(new THREE.CylinderGeometry(R*0.06,R*0.08,bH,8),
    mat(0x888888,{metal:0.7,rough:0.2}));
  base.position.set(ax,y+bH/2,az); g.add(base);
  const rod=new THREE.Mesh(new THREE.CylinderGeometry(rR,rR,rH,8),
    mat(0xaaaaaa,{metal:0.8,rough:0.15}));
  rod.position.set(ax,y+bH+rH/2,az); g.add(rod);
  const tip=new THREE.Mesh(new THREE.SphereGeometry(rR*3,8,8),
    mat(0xdd2200,{metal:0.2,rough:0.4}));
  tip.position.set(ax,y+bH+rH,az); g.add(tip);
}

/* ── horizontal stiffener rings ── */
function addStiffeners(g,baseY,h,R,spacing){
  const rMat=new THREE.MeshBasicMaterial({color:0x444450,transparent:true,opacity:0.25});
  const n=Math.floor(h/spacing);
  for(let i=1;i<n;i++){
    const geo=new THREE.TorusGeometry(R+0.003,R*0.005,6,SEG);
    const m=new THREE.Mesh(geo,rMat);
    m.rotation.x=Math.PI/2; m.position.y=baseY+i*spacing; g.add(m);
  }
}

/* ── thrust structure ring ── */
function addThrustRing(g,y,R){
  const geo=new THREE.TorusGeometry(R*EW,R*0.025,8,SEG);
  const m=new THREE.Mesh(geo,mat(0x555560,{metal:0.7,rough:0.2}));
  m.rotation.x=Math.PI/2; m.position.y=y; g.add(m);
}

/* ── separation bolt indicators ── */
function addSepBolts(g,y,R,num){
  const bMat=mat(0x888890,{metal:0.8,rough:0.15});
  const br=R*0.018;
  for(let i=0;i<num;i++){
    const a=(i/num)*Math.PI*2;
    const b=new THREE.Mesh(new THREE.SphereGeometry(br,6,6),bMat);
    b.position.set(Math.cos(a)*(R+br*0.5),y,Math.sin(a)*(R+br*0.5)); g.add(b);
  }
}

/* ── patch antenna (flat telemetry) ── */
function addPatchAntenna(g,y,R,angle){
  const pw=R*0.2, ph=R*0.16, pd=R*0.025;
  const ax=Math.cos(angle)*(R+pd/2+0.005), az=Math.sin(angle)*(R+pd/2+0.005);
  const back=new THREE.Mesh(new THREE.BoxGeometry(pw,ph,pd),
    mat(0xcccccc,{metal:0.3,rough:0.5}));
  back.position.set(ax,y,az); back.rotation.y=-angle; g.add(back);
  const face=new THREE.Mesh(new THREE.BoxGeometry(pw*0.85,ph*0.85,pd*0.3),
    mat(0xddddee,{metal:0.15,rough:0.7}));
  face.position.set(Math.cos(angle)*(R+pd+0.005),y,Math.sin(angle)*(R+pd+0.005));
  face.rotation.y=-angle; g.add(face);
}

/* ── payload surface details ── */
function addPayloadDetails(g,baseY,h,R){
  /* structural bands */
  const bdMat=mat(0x777780,{metal:0.6,rough:0.2});
  for(const f of [0.3,0.65]){
    const geo=new THREE.TorusGeometry(R+0.004,R*0.012,8,SEG);
    const m=new THREE.Mesh(geo,bdMat);
    m.rotation.x=Math.PI/2; m.position.y=baseY+h*f; g.add(m);
  }

  /* folded solar panel stubs (dark blue strips flush against body) */
  const spMat=mat(0x1a2a55,{metal:0.3,rough:0.4,coat:0.3});
  for(let i=0;i<2;i++){
    const a=Math.PI*i;
    const sp=new THREE.Mesh(new THREE.BoxGeometry(R*0.16,h*0.4,R*0.02),spMat);
    sp.position.set(Math.cos(a)*(R+R*0.01),baseY+h*0.5,Math.sin(a)*(R+R*0.01));
    sp.rotation.y=-a; g.add(sp);
  }

  /* star tracker housings */
  const stMat=mat(0x222230,{metal:0.5,rough:0.3});
  for(let i=0;i<2;i++){
    const a=Math.PI*0.5+Math.PI*i;
    const st=new THREE.Mesh(new THREE.BoxGeometry(R*0.08,R*0.06,R*0.1),stMat);
    st.position.set(Math.cos(a)*(R+R*0.045),baseY+h*0.75,Math.sin(a)*(R+R*0.045));
    st.rotation.y=-a; g.add(st);
  }

  /* top sensor dome */
  const dGeo=new THREE.SphereGeometry(R*0.15,12,8,0,Math.PI*2,0,Math.PI/2);
  const dome=new THREE.Mesh(dGeo,mat(0x333340,{metal:0.5,rough:0.3,coat:0.3}));
  dome.position.y=baseY+h; g.add(dome);

  /* thermal blanket band */
  const blGeo=new THREE.CylinderGeometry(R+0.003,R+0.003,h*0.12,SEG,1,true);
  const bl=new THREE.Mesh(blGeo,mat(0xaa8844,{metal:0.4,rough:0.35,alpha:0.55,double:true}));
  bl.position.y=baseY+h*0.15; g.add(bl);
}

/* ── access panel outlines ── */
function addAccessPanels(g,baseY,h,R){
  const lMat=new THREE.LineBasicMaterial({color:0x555560,transparent:true,opacity:0.2});
  const pw=0.1, ph=0.07;
  const panels=[
    {a:Math.PI*0.15,f:0.35},{a:Math.PI*0.65,f:0.55},
    {a:Math.PI*1.2,f:0.4},{a:Math.PI*1.7,f:0.65}
  ];
  const rr=R+0.005;
  for(const p of panels){
    const cy=baseY+h*p.f, halfArc=pw/(2*R);
    const pts=[];
    for(let j=0;j<=4;j++){
      const aa=p.a-halfArc+(j/4)*2*halfArc;
      pts.push(new THREE.Vector3(Math.cos(aa)*rr,cy-ph/2,Math.sin(aa)*rr));
    }
    pts.push(new THREE.Vector3(Math.cos(p.a+halfArc)*rr,cy+ph/2,Math.sin(p.a+halfArc)*rr));
    for(let j=4;j>=0;j--){
      const aa=p.a-halfArc+(j/4)*2*halfArc;
      pts.push(new THREE.Vector3(Math.cos(aa)*rr,cy+ph/2,Math.sin(aa)*rr));
    }
    pts.push(new THREE.Vector3(Math.cos(p.a-halfArc)*rr,cy-ph/2,Math.sin(p.a-halfArc)*rr));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),lMat));
  }
}

/* ── interstage lattice struts ── */
function addInterstageStruts(g,baseY,h,botR,topR,num){
  const strutR=Math.max(botR,topR)*0.012;
  const sMat=mat(0x888888,{metal:0.6,rough:0.2});
  for(let i=0;i<num;i++){
    const a=(i/num)*Math.PI*2;
    const path=new THREE.LineCurve3(
      new THREE.Vector3(Math.cos(a)*botR*0.95,baseY,Math.sin(a)*botR*0.95),
      new THREE.Vector3(Math.cos(a)*topR*0.95,baseY+h,Math.sin(a)*topR*0.95));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path,1,strutR,6,false),sMat));
  }
}

/* ── TVC actuators ── */
function addTVC(g,y,stageR,engLen){
  const actR=stageR*0.013;
  const actMat=mat(0x777780,{metal:0.8,rough:0.15});
  const eW=stageR*EW;
  const upperY=y+engLen*0.45;
  const lowerY=y+engLen*0.05;
  const upperR=eW*0.72;
  const lowerR=eW*0.32;
  for(let i=0;i<2;i++){
    const a=Math.PI*0.3+i*Math.PI;
    const path=new THREE.LineCurve3(
      new THREE.Vector3(Math.cos(a)*upperR,upperY,Math.sin(a)*upperR),
      new THREE.Vector3(Math.cos(a)*lowerR,lowerY,Math.sin(a)*lowerR));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path,2,actR,6,false),actMat));
    const pU=new THREE.Mesh(new THREE.SphereGeometry(actR*2.2,6,6),actMat);
    pU.position.set(Math.cos(a)*upperR,upperY,Math.sin(a)*upperR); g.add(pU);
    const pL=new THREE.Mesh(new THREE.SphereGeometry(actR*2.2,6,6),actMat);
    pL.position.set(Math.cos(a)*lowerR,lowerY,Math.sin(a)*lowerR); g.add(pL);
  }
}

/* ═══════════════ stage builders ═══════════════ */

function addStage12(g,n,y){
  const R=sk(n,'radius'), tw=R*TW;
  const engLen=sk(n,'engine_length');
  const fuelLen=sk(n,'bottom_propellant_length');
  const oxLen=sk(n,'top_propellant_length');
  const headLen=sk(n,'tank_head_length');
  const bot=y;

  addNozzle(g,y,R,engLen);
  addTVC(g,y,R,engLen);
  y=addCyl(g,R*EW,engLen,y,C.engine,{metal:0.7,rough:0.2,coat:0.3});
  addThrustRing(g,y,R);
  addRing(g,y,R);

  y=addDomeDown(g,tw,headLen,y,C.fuel);
  addCyl(g,tw,fuelLen+headLen,y,C.fuel);
  y+=fuelLen;
  y=addDomeDown(g,tw,headLen,y,C.ox);
  addRing(g,y,tw);
  const oxBot=y;
  y=addCyl(g,tw,oxLen,y,C.ox);
  y=addDomeUp(g,tw,headLen,y,C.ox);

  addWall(g,R,y-bot,bot);
  addStringers(g,bot,y-bot,R,8);
  addConduit(g,bot,y-bot,R,Math.PI*1.0);
  addConduit(g,bot,y-bot,R,Math.PI*2.0);
  addRing(g,y,R);
  return {y, oxBot, oxLen, oxR:tw};
}

function addStage3(g,y){
  const R=sk(3,'radius');
  const engLen=sk(3,'engine_length');
  const bot=y;

  addNozzle(g,y,R,engLen);
  addTVC(g,y,R,engLen);
  y=addCyl(g,R*EW,engLen,y,C.engine,{metal:0.7,rough:0.2,coat:0.3});
  addThrustRing(g,y,R);
  y+=GAP;
  addSphere(g,R,y+R,C.fuel);
  y+=R*2+GAP;
  addSphere(g,R,y+R,C.ox);
  y+=R*2;
  addWall(g,R,y-bot,bot);
  addStringers(g,bot,y-bot,R,6);
  addRing(g,y,R);
  return y;
}

/* ── logo & flag decals (curved plates on cylinder surface) ── */
const LOGO_B64 = "__LOGO_B64__";
const LOGO_ASPECT = __LOGO_ASPECT__;
const FLAG_B64 = "__FLAG_B64__";
const FLAG_ASPECT = __FLAG_ASPECT__;

function _addDecalRing(g, dataURI, aspect, arcAngle, decalR, centerY, matOpts){
  const arcLen=arcAngle*decalR;
  const h=arcLen/aspect;
  const img=new Image();
  img.onload=function(){
    const cvs=document.createElement('canvas');
    cvs.width=img.naturalWidth||img.width;
    cvs.height=img.naturalHeight||img.height;
    const ctx=cvs.getContext('2d');
    ctx.drawImage(img,0,0,cvs.width,cvs.height);
    const tex=new THREE.CanvasTexture(cvs);
    tex.colorSpace=THREE.SRGBColorSpace;

    const m=new THREE.MeshBasicMaterial(Object.assign({
      map:tex, side:THREE.DoubleSide,
      transparent:true, depthWrite:false,
      polygonOffset:true,
      polygonOffsetFactor:-4,
      polygonOffsetUnits:-4,
    }, matOpts||{}));

    for(let i=0;i<2;i++){
      const geo=new THREE.CylinderGeometry(
        decalR,decalR,h,64,1,true,
        Math.PI*i - arcAngle/2, arcAngle
      );
      const mesh=new THREE.Mesh(geo,m.clone());
      mesh.position.y=centerY;
      g.add(mesh);
    }
  };
  img.src=dataURI;
  return h;
}

function addLogos(g, oxBot, oxLen, oxR){
  const decalR=oxR+0.03;
  const gap=0.2;

  const logoArc=Math.PI*0.85;
  const logoArcLen=logoArc*decalR;
  const logoH=logoArcLen/LOGO_ASPECT;

  const flagArc=Math.PI*0.3;
  const flagArcLen=flagArc*decalR;
  const flagH=flagArcLen/FLAG_ASPECT;

  const totalH=logoH+gap+flagH;
  const blockCenter=oxBot+oxLen/2;
  const logoCenter=blockCenter+totalH/2-logoH/2;
  const flagCenter=blockCenter-totalH/2+flagH/2;

  if(LOGO_B64){
    _addDecalRing(g,'data:image/png;base64,'+LOGO_B64,
      LOGO_ASPECT,logoArc,decalR,logoCenter,{color:0x1a1a2e});
  }
  if(FLAG_B64){
    _addDecalRing(g,'data:image/jpeg;base64,'+FLAG_B64,
      FLAG_ASPECT,flagArc,decalR,flagCenter,{});
  }
}

/* ═══════════════ build full rocket ═══════════════ */

function buildRocket(){
  const g=new THREE.Group();
  let y=0;

  /* stage 1 */
  const s1bot=0;
  let s1=addStage12(g,1,y);
  y=s1.y;

  /* interstage 1-2 */
  const is12bot=y;
  addRing(g,y,Math.max(D.stage1_radius,D.stage2_radius));
  y=addCone(g,D.stage2_radius,D.stage1_radius,
            D.stage12_interstage_length,y,C.inter,{alpha:0.25,double:true,metal:0.3,rough:0.35});
  addInterstageStruts(g,is12bot,D.stage12_interstage_length,D.stage1_radius,D.stage2_radius,6);
  addRCSPods(g,is12bot+D.stage12_interstage_length*0.5,D.stage1_radius,4);
  addSepBolts(g,is12bot,Math.max(D.stage1_radius,D.stage2_radius),12);
  addRing(g,y,D.stage2_radius);
  addSepBolts(g,y,D.stage2_radius,12);

  /* stage 2 */
  const s2bot=y;
  let s2=addStage12(g,2,y);
  y=s2.y;

  /* interstage 2-3 */
  const s3base=y;
  addRing(g,y,Math.max(D.stage2_radius,D.stage3_radius));
  y=addCone(g,D.stage3_radius,D.stage2_radius,
            D.stage23_interstage_length,y,C.inter,{alpha:0.25,double:true,metal:0.3,rough:0.35});
  addInterstageStruts(g,s3base,D.stage23_interstage_length,D.stage2_radius,D.stage3_radius,6);
  addRCSPods(g,s3base+D.stage23_interstage_length*0.5,D.stage2_radius,4);
  addSepBolts(g,s3base,Math.max(D.stage2_radius,D.stage3_radius),12);
  addRing(g,y,D.stage3_radius);
  addSepBolts(g,y,D.stage3_radius,12);

  /* stage 3 */
  const s3engBot=y;
  y=addStage3(g,y);

  /* payload — golden MLI foil finish */
  const plBot=y;
  y=addCyl(g,D.payload_radius,D.payload_length,y,C.payload,{metal:0.65,rough:0.2,coat:0.6,coatR:0.1});
  addPayloadDetails(g,plBot,D.payload_length,D.payload_radius);
  addAntenna(g,plBot+D.payload_length*0.3,D.payload_radius,Math.PI/2);
  addPatchAntenna(g,plBot+D.payload_length*0.6,D.payload_radius,-Math.PI/2);
  addRing(g,y,D.payload_radius);

  /* fairing — cylindrical body + ogive nose closure */
  const fBot=s3base+D.stage23_interstage_length+sk(3,'engine_length')+GAP;
  const fRad=D.fairing_radius*1.15;
  const plTop=y;
  const fCylH=(plTop-fBot)+fRad*0.4;
  const fNoseH=fRad*1.6;
  const fLen=fCylH+fNoseH;
  const fTop=fBot+fLen;

  /* profile: straight cylinder then smooth ogive taper */
  const fPts=[];
  const N=48;
  for(let i=0;i<=N;i++){
    const t=i/N;
    const h=t*fLen;
    let r;
    if(h<=fCylH){
      r=fRad;
    }else{
      const s=(h-fCylH)/fNoseH;
      r=fRad*Math.sqrt(1-s*s);
    }
    fPts.push(new THREE.Vector2(Math.max(r,0.001),h));
  }
  fPts.push(new THREE.Vector2(0.001,fLen));
  const fGeo=new THREE.LatheGeometry(fPts,SEG);
  const fM=new THREE.Mesh(fGeo,mat(C.fairing,{alpha:0.22,double:true,rough:0.25,coat:0.3}));
  fM.position.y=fBot;
  g.add(fM);

  /* fairing seam lines */
  const seamMat=new THREE.LineBasicMaterial({color:0x555555,transparent:true,opacity:0.5});
  for(let s=0;s<2;s++){
    const pts2=[];
    for(let i=0;i<=N;i++){
      const t=i/N;
      const fy=fBot+t*fLen;
      const h=t*fLen;
      let fr;
      if(h<=fCylH){fr=fRad;}
      else{const q=(h-fCylH)/fNoseH;fr=fRad*Math.sqrt(1-q*q);}
      fr=Math.max(fr,0.001);
      const a=s*Math.PI;
      pts2.push(new THREE.Vector3(Math.cos(a)*fr,fy,Math.sin(a)*fr));
    }
    const lg=new THREE.BufferGeometry().setFromPoints(pts2);
    g.add(new THREE.Line(lg,seamMat));
  }

  /* lightning protection strips */
  const lpMat=new THREE.LineBasicMaterial({color:0x666666,transparent:true,opacity:0.3});
  for(let s=0;s<3;s++){
    const la=Math.PI*0.5+s*Math.PI*0.67;
    const pts3=[];
    for(let i=0;i<=N;i++){
      const t=i/N;
      const fy=fBot+t*fLen;
      const h=t*fLen;
      let fr;
      if(h<=fCylH){fr=fRad;}
      else{const q=(h-fCylH)/fNoseH;fr=fRad*Math.sqrt(1-q*q);}
      fr=Math.max(fr,0.001);
      pts3.push(new THREE.Vector3(Math.cos(la)*fr,fy,Math.sin(la)*fr));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3),lpMat));
  }

  /* outer shell — very transparent thin cylinder from base to fairing */
  const shellR=Math.max(D.stage1_radius,D.stage2_radius)+0.02;
  const shellH=fBot-s1bot;
  const shellGeo=new THREE.CylinderGeometry(shellR,shellR,shellH,SEG,1,true);
  const shellMat=mat(0xc0c0d0,{alpha:0.14,double:true});
  const shellMesh=new THREE.Mesh(shellGeo,shellMat);
  shellMesh.position.y=s1bot+shellH/2;
  g.add(shellMesh);

  /* stiffener rings + access panels on shell */
  addStiffeners(g,s1bot,shellH,shellR,0.8);
  addAccessPanels(g,s1bot,sk(1,'length'),shellR);
  addAccessPanels(g,s2bot,sk(2,'length'),shellR);

  /* fins on all three engines */
  addFins(g, s1bot,   D.stage1_radius, 4, sk(1,'engine_length'));
  addFins(g, s2bot,   D.stage2_radius, 4, sk(2,'engine_length'));
  addFins(g, s3engBot, D.stage3_radius, 3, sk(3,'engine_length'));

  /* logo decals on stage 2 oxidizer — placed outside the shell */
  addLogos(g, s2.oxBot, s2.oxLen, shellR);

  /* center vertically */
  const totalH=fTop;
  g.position.y=-totalH/2;
  return {group:g,totalH};
}

/* ═══════════════ scene ═══════════════ */

const scene=new THREE.Scene();

/* orbital space background */
(function(){
  const S=2048;
  const c=document.createElement('canvas');c.width=S;c.height=S;
  const x=c.getContext('2d');

  /* deep-space gradient */
  const bg=x.createLinearGradient(0,0,0,S);
  bg.addColorStop(0,'#010103');bg.addColorStop(0.5,'#020206');bg.addColorStop(1,'#010103');
  x.fillStyle=bg; x.fillRect(0,0,S,S);

  /* Milky Way band */
  x.save(); x.translate(S/2,S/2); x.rotate(-0.5);
  const mw=x.createLinearGradient(0,-S*0.12,0,S*0.12);
  mw.addColorStop(0,'rgba(0,0,0,0)');
  mw.addColorStop(0.3,'rgba(30,25,45,0.04)');
  mw.addColorStop(0.5,'rgba(40,35,55,0.06)');
  mw.addColorStop(0.7,'rgba(30,25,45,0.04)');
  mw.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=mw; x.fillRect(-S,-S*0.15,S*2,S*0.3); x.restore();

  /* nebula tint */
  const nb=x.createRadialGradient(S*0.7,S*0.3,0,S*0.7,S*0.3,S*0.35);
  nb.addColorStop(0,'rgba(60,20,45,0.03)');
  nb.addColorStop(0.5,'rgba(35,15,35,0.015)');
  nb.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=nb; x.fillRect(0,0,S,S);

  /* distant sun glow */
  const sg=x.createRadialGradient(S*0.82,S*0.15,0,S*0.82,S*0.15,S*0.18);
  sg.addColorStop(0,'rgba(255,240,200,0.15)');
  sg.addColorStop(0.2,'rgba(255,220,160,0.05)');
  sg.addColorStop(0.5,'rgba(255,200,120,0.01)');
  sg.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=sg; x.fillRect(0,0,S,S);

  /* subtle bottom glow */
  const earthY=S+760, earthR=1040;
  const eg=x.createRadialGradient(S/2,earthY,earthR*0.7,S/2,earthY,earthR);
  eg.addColorStop(0,'rgba(20,60,140,0.35)');
  eg.addColorStop(0.4,'rgba(30,90,180,0.18)');
  eg.addColorStop(0.7,'rgba(15,50,120,0.06)');
  eg.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=eg; x.fillRect(0,0,S,S);

  /* star field */
  for(let i=0;i<1200;i++){
    const sx=Math.random()*S, sy=Math.random()*S;
    const br=Math.random();
    const rad=br<0.85?0.5:br<0.95?1.0:br<0.98?1.5:2.2;
    const alpha=0.2+Math.random()*0.6;
    x.beginPath(); x.arc(sx,sy,rad,0,Math.PI*2);
    const tint=br>0.95?'160,190,255':br>0.88?'255,230,200':br>0.82?'255,200,180':'255,255,255';
    x.fillStyle='rgba('+tint+','+alpha+')'; x.fill();
    if(rad>1.2){
      x.beginPath(); x.arc(sx,sy,rad*2.5,0,Math.PI*2);
      x.fillStyle='rgba('+tint+','+(alpha*0.08)+')'; x.fill();
    }
  }

  scene.background=new THREE.CanvasTexture(c);
})();

/* 3-D star particles */
(function(){
  function stars(n,rng,sz,op,col){
    const pos=new Float32Array(n*3);
    for(let i=0;i<n;i++){
      pos[i*3]  =(Math.random()-.5)*rng*2;
      pos[i*3+1]=(Math.random()-.5)*rng*2;
      pos[i*3+2]=(Math.random()-.5)*rng*2;
    }
    const sg=new THREE.BufferGeometry();
    sg.setAttribute('position',new THREE.BufferAttribute(pos,3));
    scene.add(new THREE.Points(sg,new THREE.PointsMaterial({
      color:col||0xffffff,size:sz,transparent:true,opacity:op,sizeAttenuation:true
    })));
  }
  stars(3000,300,0.04,0.4);
  stars(500,250,0.12,0.7);
  stars(80,200,0.25,0.9);
  stars(120,280,0.08,0.5,0xaabbff);
  stars(60,260,0.08,0.4,0xffddaa);
})();

const {group:rocketInner,totalH}=buildRocket();
const rocket=new THREE.Group();
rocket.add(rocketInner);
scene.add(rocket);

/* lighting */
scene.add(new THREE.AmbientLight(0xffffff,0.3));
scene.add(new THREE.HemisphereLight(0x4466aa,0x111118,0.35));

const sun=new THREE.DirectionalLight(0xfff4e0,1.2);
sun.position.set(8,14,6); scene.add(sun);

const fill=new THREE.DirectionalLight(0x8899cc,0.3);
fill.position.set(-6,3,-8); scene.add(fill);

const rim=new THREE.DirectionalLight(0x99aadd,0.25);
rim.position.set(-2,-6,10); scene.add(rim);

const kick=new THREE.DirectionalLight(0xffeedd,0.15);
kick.position.set(3,-8,-4); scene.add(kick);

/* camera */
const aspect=window.innerWidth/window.innerHeight;
const cam=new THREE.PerspectiveCamera(36,aspect,0.05,totalH*8);
const dist=totalH*0.65;
cam.position.set(dist*0.55,totalH*0.05,dist*0.5);
cam.lookAt(0,totalH*0.02,0);

/* renderer */
const ren=new THREE.WebGLRenderer({antialias:true,alpha:false});
ren.setSize(window.innerWidth,window.innerHeight);
ren.setPixelRatio(Math.min(window.devicePixelRatio,2));
ren.toneMapping=THREE.ACESFilmicToneMapping;
ren.toneMappingExposure=1.2;
document.body.appendChild(ren.domElement);

/* controls */
const ctrl=new OrbitControls(cam,ren.domElement);
ctrl.enableDamping=true;ctrl.dampingFactor=0.05;
ctrl.autoRotate=true;ctrl.autoRotateSpeed=1.4;
ctrl.minDistance=totalH*0.12;
ctrl.maxDistance=totalH*2.5;
ctrl.target.set(0,totalH*0.02,0);

/* focus slider */
const _fSlider=document.getElementById('focusSlider');
const _fMin=-totalH/2, _fMax=totalH/2;
_fSlider.value=((totalH*0.02-_fMin)/(_fMax-_fMin))*100;
let _focusTarget=ctrl.target.y;
_fSlider.addEventListener('input',function(){
  _focusTarget=_fMin+(this.value/100)*(_fMax-_fMin);
});

/* auto-rotate pause/resume */
let _st;
ren.domElement.addEventListener('pointerdown',()=>{
  ctrl.autoRotate=false;clearTimeout(_st);
  document.getElementById('autoBtn').textContent='Resume rotation';
});
ren.domElement.addEventListener('pointerup',()=>{
  clearTimeout(_st);
  _st=setTimeout(()=>{
    ctrl.autoRotate=true;
    document.getElementById('autoBtn').textContent='Pause rotation';
  },4000);
});

window.toggleSpin=function(){
  ctrl.autoRotate=!ctrl.autoRotate;clearTimeout(_st);
  document.getElementById('autoBtn').textContent=
    ctrl.autoRotate?'Pause rotation':'Resume rotation';
};

let _horizontal=false, _tiltTarget=0, _tiltCurrent=0;
window.toggleTilt=function(){
  _horizontal=!_horizontal;
  _tiltTarget=_horizontal?-Math.PI/2:0;
  document.getElementById('tiltBtn').textContent=
    _horizontal?'Vertical view':'Horizontal view';
};

/* animation */
(function loop(){
  requestAnimationFrame(loop);
  _tiltCurrent+=(_tiltTarget-_tiltCurrent)*0.06;
  rocket.rotation.z=_tiltCurrent;
  ctrl.target.y+=(_focusTarget-ctrl.target.y)*0.08;
  ctrl.update();
  ren.render(scene,cam);
})();

/* resize */
window.addEventListener('resize',()=>{
  cam.aspect=window.innerWidth/window.innerHeight;
  cam.updateProjectionMatrix();
  ren.setSize(window.innerWidth,window.innerHeight);
});
</script>
</body>
</html>
"""
