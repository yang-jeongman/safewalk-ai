// 객체 추적기 — COCO-SSD는 매 프레임 독립적인 박스만 줄 뿐 "같은 차가 계속
// 이어지고 있다"는 정체성이 없다. 진행방향 화살표(사용자 요청 2026-09-19:
// "차량이 다가오는/멀어지는 방향으로 화살표 표시")를 그리려면 프레임 간 같은
// 물체를 대응시켜 이동 벡터를 계산해야 한다 — 정밀한 추적기가 아니라, 클래스가
// 같고 중심점이 가장 가까운 것끼리 잇는 단순 그리디 매칭이다.
export class ObjectTracker {
    constructor(options = {}) {
        this.tracks = new Map(); // id -> { class, cx, cy, lastSeen, history: [{cx,cy,height,t}] }
        this.nextId = 1;
        this.maxMatchDistance = options.maxMatchDistance ?? 80; // px, 중심점 매칭 최대 거리
        this.maxAgeMs = options.maxAgeMs ?? 1500; // 이 시간 이상 못 보면 트랙 삭제
        this.historyLength = options.historyLength ?? 5;
    }

    // predictions({class, bbox, ...})에 trackId + motionVector(px/s) + sizeChangeRate(px/s)를 붙여 반환
    update(predictions, now = performance.now()) {
        for (const [id, track] of this.tracks) {
            if (now - track.lastSeen > this.maxAgeMs) this.tracks.delete(id);
        }

        const usedTrackIds = new Set();

        return predictions.map((pred) => {
            const [x, y, w, h] = pred.bbox;
            const cx = x + w / 2;
            const cy = y + h / 2;

            let bestId = null;
            let bestDist = this.maxMatchDistance;
            for (const [id, track] of this.tracks) {
                if (usedTrackIds.has(id) || track.class !== pred.class) continue;
                const d = Math.hypot(track.cx - cx, track.cy - cy);
                if (d < bestDist) {
                    bestDist = d;
                    bestId = id;
                }
            }

            let track;
            if (bestId !== null) {
                track = this.tracks.get(bestId);
                usedTrackIds.add(bestId);
            } else {
                bestId = this.nextId++;
                track = { class: pred.class, history: [] };
                this.tracks.set(bestId, track);
                usedTrackIds.add(bestId);
            }

            track.cx = cx;
            track.cy = cy;
            track.lastSeen = now;
            track.history.push({ cx, cy, height: h, t: now });
            while (track.history.length > this.historyLength) track.history.shift();

            let motionVector = null;
            let sizeChangeRate = null;
            if (track.history.length >= 2) {
                const first = track.history[0];
                const last = track.history[track.history.length - 1];
                const dt = (last.t - first.t) / 1000;
                if (dt > 0.05) { // 너무 짧은 간격은 노이즈에 취약해 제외
                    motionVector = {
                        dx: (last.cx - first.cx) / dt,
                        dy: (last.cy - first.cy) / dt
                    };
                    sizeChangeRate = (last.height - first.height) / dt; // 양수=커짐(접근), 음수=작아짐(멀어짐)
                }
            }

            return { ...pred, trackId: bestId, motionVector, sizeChangeRate };
        });
    }

    reset() {
        this.tracks.clear();
        this.nextId = 1;
    }
}
