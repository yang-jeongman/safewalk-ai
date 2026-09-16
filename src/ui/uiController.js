// UI 컨트롤러 모듈
export class UIController {
    constructor() {
        this.currentScreen = 'main';
        this.screens = {};
        this.dangerLevelElement = null;
    }

    init() {
        // 모든 화면 요소 캐싱
        this.screens = {
            splash: document.getElementById('splash'),
            main: document.getElementById('main'),
            walking: document.getElementById('walking'),
            settings: document.getElementById('settings'),
            report: document.getElementById('report')
        };

        // 위험도 표시 요소
        this.dangerLevelElement = document.getElementById('dangerLevel');

        // 설정 이벤트 바인딩
        this.bindSettingsEvents();
    }

    switchScreen(screenName) {
        // 아직 안 만들어진 화면(예: 프로필)으로 전환 시도하면 현재 화면을
        // 그대로 두고 무시한다 — 예전엔 여기서 currentScreen을 먼저 숨겨버려서
        // 목적지 화면이 없으면 빈 흰 화면만 남는 버그가 있었다.
        if (!this.screens[screenName]) {
            console.warn(`화면 "${screenName}"이(가) 아직 없습니다`);
            return;
        }

        // 현재 화면 숨기기
        if (this.screens[this.currentScreen]) {
            this.screens[this.currentScreen].classList.remove('active');
        }

        // 새 화면 표시
        this.screens[screenName].classList.add('active');
        this.currentScreen = screenName;

        // 네비게이션 업데이트
        this.updateNavigation(screenName);
    }

    updateNavigation(screenName) {
        // 네비게이션 아이템 업데이트
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.screen === screenName) {
                item.classList.add('active');
            }
        });
    }

    updateStatus(type, data) {
        switch (type) {
            case 'walking':
                if (data.status === 'active') {
                    document.querySelector('.status-icon').textContent = '🔴';
                    document.querySelector('.status-text').textContent = '보행 감지 중';
                    document.querySelector('.walking-indicator').textContent = '● 감지중';
                } else {
                    document.querySelector('.status-icon').textContent = '🟢';
                    document.querySelector('.status-text').textContent = '안전 모드 대기중';
                }
                break;
        }
    }

    showAlert(message, type = 'info') {
        const alert = document.createElement('div');
        alert.className = `system-alert ${type}`;
        alert.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#2196F3'};
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 10000;
            animation: slideDown 0.3s ease;
        `;
        alert.textContent = message;

        document.body.appendChild(alert);

        setTimeout(() => {
            alert.style.animation = 'slideUp 0.3s ease';
            setTimeout(() => alert.remove(), 300);
        }, 3000);
    }

    // 신호등 색 전용 배너 문구 — warningSystem.generateMessage()의 음성 안내와
    // 동일한 문구를 화면에도 보여준다. 해당 없으면 null.
    describeTrafficLight(threat) {
        if (threat.class !== 'traffic light' || !threat.trafficLightColor) return null;
        const text = {
            red: '빨간불, 건너지 마세요',
            yellow: '노란불, 곧 바뀝니다',
            green: '초록불, 건너도 안전합니다'
        }[threat.trafficLightColor];
        return text || null;
    }

    showDanger(threat) {
        this.updateDangerLevel(threat.level);

        // 위험 정보 표시
        const alertZone = document.getElementById('alertZone');
        if (!alertZone) return;

        // 신호등은 색 전용 문구 사용 — warningSystem.generateMessage()의
        // 음성 안내와 화면 배너가 다른 문구를 보여주지 않도록 맞춘다
        const body = this.describeTrafficLight(threat) || `
            ${threat.direction} ${threat.class}<br>
            거리: ${threat.distance.toFixed(1)}m
        `;

        const alert = document.createElement('div');
        alert.className = 'alert danger';
        alert.innerHTML = `
            <strong>⚠️ 위험!</strong><br>
            ${body}
        `;

        alertZone.innerHTML = '';
        alertZone.appendChild(alert);
        alertZone.classList.add('active');

        // 3초 후 제거
        setTimeout(() => {
            alert.remove();
            if (alertZone.children.length === 0) {
                alertZone.classList.remove('active');
            }
        }, 3000);
    }

    showWarning(threat) {
        this.updateDangerLevel(threat.level);

        const alertZone = document.getElementById('alertZone');
        if (!alertZone) return;

        const body = this.describeTrafficLight(threat) || `${threat.direction} ${threat.class}`;

        const alert = document.createElement('div');
        alert.className = 'alert warning';
        alert.innerHTML = `
            <strong>주의</strong><br>
            ${body}
        `;

        alertZone.innerHTML = '';
        alertZone.appendChild(alert);
        alertZone.classList.add('active');

        setTimeout(() => {
            alert.remove();
            if (alertZone.children.length === 0) {
                alertZone.classList.remove('active');
            }
        }, 2000);
    }

    updateDangerLevel(level) {
        if (!this.dangerLevelElement) return;

        const percentage = Math.min(100, Math.round(level * 100));
        const fillElement = this.dangerLevelElement.querySelector('.level-fill');
        const textElement = this.dangerLevelElement.querySelector('.level-text');

        // 위험도 바 업데이트
        fillElement.style.width = `${percentage}%`;

        // 색상 변경
        let color = '#4CAF50'; // 녹색
        let text = '안전';

        if (level > 0.7) {
            color = '#f44336'; // 빨강
            text = '위험';
        } else if (level > 0.4) {
            color = '#ff9800'; // 주황
            text = '주의';
        }

        fillElement.style.backgroundColor = color;
        textElement.textContent = text;
    }

    bindSettingsEvents() {
        // 음성 경고 설정
        const voiceAlert = document.getElementById('voiceAlert');
        if (voiceAlert) {
            voiceAlert.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                localStorage.setItem('voiceAlert', enabled);
            });

            // 저장된 설정 로드
            const saved = localStorage.getItem('voiceAlert');
            if (saved !== null) {
                voiceAlert.checked = saved === 'true';
            }
        }

        // 진동 경고 설정
        const vibrationAlert = document.getElementById('vibrationAlert');
        if (vibrationAlert) {
            vibrationAlert.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                localStorage.setItem('vibrationAlert', enabled);
            });

            const saved = localStorage.getItem('vibrationAlert');
            if (saved !== null) {
                vibrationAlert.checked = saved === 'true';
            }
        }

        // 민감도 설정
        const sensitivity = document.getElementById('sensitivity');
        if (sensitivity) {
            sensitivity.addEventListener('change', (e) => {
                const value = e.target.value;
                localStorage.setItem('sensitivity', value);
            });

            const saved = localStorage.getItem('sensitivity');
            if (saved) {
                sensitivity.value = saved;
            }
        }

        // 이모지 투명도 (감지 결과를 원본 영상 대신 이모지로만 표시)
        const emojiOpacity = document.getElementById('emojiOpacity');
        if (emojiOpacity) {
            emojiOpacity.addEventListener('input', (e) => {
                localStorage.setItem('emojiOpacity', e.target.value);
            });

            const saved = localStorage.getItem('emojiOpacity');
            if (saved) {
                emojiOpacity.value = saved;
            }
        }

        // 미지 객체 학습 참여 (Phase 2 open-set 인식, 기본값 OFF)
        const unknownObjectContribution = document.getElementById('unknownObjectContribution');
        if (unknownObjectContribution) {
            unknownObjectContribution.addEventListener('change', (e) => {
                localStorage.setItem('unknownObjectContribution', String(e.target.checked));
            });

            unknownObjectContribution.checked = localStorage.getItem('unknownObjectContribution') === 'true';
        }
    }

    // 통계 표시 업데이트
    updateStats(stats) {
        // 안전 점수
        const scoreElement = document.getElementById('safetyScore');
        if (scoreElement && stats.safetyScore !== undefined) {
            scoreElement.textContent = stats.safetyScore;
        }

        // 보행 시간
        const walkTimeElement = document.getElementById('walkTime');
        if (walkTimeElement && stats.walkTime !== undefined) {
            walkTimeElement.textContent = stats.walkTime;
        }

        // 위험 감지 횟수
        const dangerCountElement = document.getElementById('dangerCount');
        if (dangerCountElement && stats.dangerCount !== undefined) {
            dangerCountElement.textContent = stats.dangerCount;
        }
    }

    // 리포트 화면 렌더링 — dataManager.getStats()의 recentSessions(최근 7일)와
    // analyzeDangerPatterns()의 결과를 화면에 채운다.
    renderReport(stats, patterns) {
        const sessions = stats.recentSessions || [];

        const totalWalkTime = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
        const totalDangers = sessions.reduce((sum, s) => sum + (s.dangerCount || 0), 0);
        const avgScore = sessions.length > 0
            ? Math.round(sessions.reduce((sum, s) => sum + (s.safetyScore || 0), 0) / sessions.length)
            : null;

        const walkTimeEl = document.getElementById('reportWalkTime');
        if (walkTimeEl) walkTimeEl.textContent = `${Math.round(totalWalkTime / 60000)}분`;

        const dangerCountEl = document.getElementById('reportDangerCount');
        if (dangerCountEl) dangerCountEl.textContent = `${totalDangers}회`;

        const avgScoreEl = document.getElementById('reportAvgScore');
        if (avgScoreEl) avgScoreEl.textContent = avgScore !== null ? avgScore : '--';

        // 최근 보행 기록 (최신순, 최대 10개)
        const sessionListEl = document.getElementById('reportSessionList');
        if (sessionListEl) {
            const sorted = [...sessions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
            if (sorted.length === 0) {
                sessionListEl.innerHTML = '<p class="report-empty">아직 기록이 없습니다. 보행을 시작해보세요.</p>';
            } else {
                sessionListEl.innerHTML = sorted.map(s => {
                    const date = new Date(s.timestamp);
                    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    const minutes = Math.round((s.duration || 0) / 60000);
                    return `
                        <div class="report-session-item">
                            <span class="report-session-date">${dateStr}</span>
                            <span>${minutes}분 · 위험 ${s.dangerCount || 0}회</span>
                            <span>${s.safetyScore ?? '--'}점</span>
                        </div>
                    `;
                }).join('');
            }
        }

        // 자주 감지된 물체
        const objListEl = document.getElementById('reportObjectFrequency');
        if (objListEl) {
            const objectNames = {
                car: '자동차', bus: '버스', truck: '트럭', motorcycle: '오토바이',
                bicycle: '자전거', person: '사람', 'traffic light': '신호등',
                'stop sign': '정지 표지판', unknown: '정체불명의 물체'
            };
            const entries = Object.entries(patterns?.mostFrequentObject || {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8);

            if (entries.length === 0) {
                objListEl.innerHTML = '<p class="report-empty">아직 기록이 없습니다.</p>';
            } else {
                objListEl.innerHTML = entries.map(([cls, count]) => `
                    <div class="report-object-item">
                        <span>${objectNames[cls] || cls}</span>
                        <span>${count}회</span>
                    </div>
                `).join('');
            }
        }
    }

    // 로딩 표시
    showLoading(show = true) {
        const loading = document.querySelector('.loading-spinner');
        if (loading) {
            loading.style.display = show ? 'block' : 'none';
        }
    }
}