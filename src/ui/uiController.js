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
            report: document.getElementById('report'),
            plateScan: document.getElementById('plateScan')
        };

        // 위험도 표시 요소
        this.dangerLevelElement = document.getElementById('dangerLevel');

        // 설정 이벤트 바인딩
        this.bindSettingsEvents();

        // 관리자 도구(번호판 조회 모드) 노출 여부 — 일반 보행자 사용자에게는 기본 숨김
        this.applyAdminToolsVisibility();
    }

    // 설정의 "관리자 도구 표시"가 꺼져 있으면 메인 화면의 번호판 조회 진입 버튼을 숨긴다.
    applyAdminToolsVisibility() {
        const enabled = localStorage.getItem('adminToolsEnabled') === 'true';
        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = enabled ? '' : 'none';
        });
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

    // 비동기로 만들어진 Blob(ZIP/텍스트 내보내기 등)을 실제로 저장하려면, 사용자가
    // "지금 막 누른" 진짜 <a> 탭이어야 한다 — a.click()을 코드로 대신 호출하면
    // iOS Safari에서 다운로드가 막힌다(실기기 확인, 2026-09-19. 이유는
    // zipWriter.js 상단 주석 참고). 그래서 배너 안에 진짜 링크를 넣고 사용자가
    // 직접 누르게 한다. showAlert()와 달리 수 초 만에 사라지지 않는다 —
    // 링크를 누르기 전에 없어지면 저장할 방법이 없어지기 때문.
    presentDownload(blob, filename, label) {
        const url = URL.createObjectURL(blob);

        const banner = document.createElement('div');
        banner.className = 'download-ready-banner';
        banner.innerHTML = `
            <span>${label || '내보내기 준비됨'}</span>
            <a href="${url}" download="${filename}" class="download-ready-link">💾 저장</a>
            <button class="download-ready-close" aria-label="닫기">✕</button>
        `;
        document.body.appendChild(banner);

        const cleanup = () => {
            banner.remove();
            URL.revokeObjectURL(url);
        };

        banner.querySelector('.download-ready-close').addEventListener('click', cleanup);
        // 저장 링크를 누르면 브라우저가 다운로드를 시작할 시간을 잠깐 준 뒤 정리한다
        banner.querySelector('.download-ready-link').addEventListener('click', () => {
            setTimeout(cleanup, 1500);
        });
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

        // 관리자 도구 표시 — 번호판 조회 모드(공무원/파일럿 시연용) 진입 버튼 노출 여부.
        // 기본 OFF: 일반 보행자 사용자는 이 기능의 존재 자체를 모르게 한다.
        const adminTools = document.getElementById('adminToolsEnabled');
        if (adminTools) {
            adminTools.addEventListener('change', (e) => {
                localStorage.setItem('adminToolsEnabled', String(e.target.checked));
                this.applyAdminToolsVisibility();
            });
            adminTools.checked = localStorage.getItem('adminToolsEnabled') === 'true';
        }
    }

    // 번호판 조회 모드 — 업로드된 체납차량 목록 개수 표시
    updatePlateCsvSummary(count) {
        const el = document.getElementById('plateCsvSummary');
        if (el) el.textContent = count > 0 ? `목록 ${count}건 로드됨` : '업로드된 목록 없음';
    }

    updatePlateScanStatus(text) {
        const el = document.getElementById('plateScanStatus');
        if (el) el.textContent = text;
    }

    setPlateCaptureEnabled(enabled) {
        const btn = document.getElementById('btnPlateCapture');
        if (btn) btn.disabled = !enabled;
    }

    // 수동 캡처 직후 즉시 피드백 — 매칭 여부와 무관하게 매 캡처마다 호출된다.
    // "인식됨: XXX" 처럼 바로 보여줘서, 정확도 테스트 로그를 나중에 열어보지 않아도
    // 그 자리에서 결과를 확인할 수 있게 한다(사용자 요청: "폰에서 결과를 볼 수 없다").
    showPlateCaptureResult(result) {
        const el = document.getElementById('plateCaptureResult');
        if (!el) return;
        el.hidden = false;

        const blurWarning = result.sharpness < 60
            ? '<div class="plate-capture-warning">사진이 흐릴 수 있습니다 — 더 가까이, 정면에서 다시 시도해보세요</div>'
            : '';
        const matchLine = result.match
            ? `<div class="plate-capture-match">⚠️ 체납차량 매칭: ${result.match.plate}</div>`
            : '<div class="plate-capture-nomatch">목록에 없음</div>';

        el.innerHTML = `
            <div class="plate-capture-text">인식됨: ${result.text || '(읽지 못함)'}</div>
            ${result.colorLabel ? `<div class="plate-capture-color">${result.colorLabel}</div>` : ''}
            ${matchLine}
            ${blurWarning}
        `;
    }

    // 매칭 발생 시 화면 배너 — 음성/진동은 app.js가 warningSystem으로 별도 처리
    showPlateMatchAlert(match) {
        const zone = document.getElementById('plateAlertZone');
        if (!zone) return;
        const alert = document.createElement('div');
        alert.className = 'alert danger';
        alert.innerHTML = `
            <strong>⚠️ 체납차량 발견</strong><br>
            번호판: ${match.plate}${match.matchType === 'fuzzy' ? ' (유사 매칭, 확인 필요)' : ''}
            ${match.colorLabel ? ` · ${match.colorLabel}` : ''}
            ${match.note ? `<br>${match.note}` : ''}
        `;
        zone.innerHTML = '';
        zone.appendChild(alert);
        zone.classList.add('active');
        setTimeout(() => {
            alert.remove();
            zone.classList.remove('active');
        }, 5000);
    }

    // 번호판 조회 모드 — 오늘/최근 매칭 기록 목록 (매칭 안 된 차량은 애초에 저장 안 됨)
    renderPlateScanLog(scans) {
        const el = document.getElementById('plateScanLog');
        if (!el) return;
        if (!scans || scans.length === 0) {
            el.innerHTML = '<p class="report-empty">아직 매칭 기록이 없습니다.</p>';
            return;
        }
        el.innerHTML = scans.slice(0, 30).map(s => {
            const date = new Date(s.timestamp);
            const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            return `
                <div class="report-session-item">
                    <span class="report-session-date">${dateStr}</span>
                    <span>${s.plate}${s.matchType === 'fuzzy' ? ' (유사)' : ''}${s.colorLabel ? ` · ${s.colorLabel}` : ''}</span>
                    <span>${s.note || ''}</span>
                </div>
            `;
        }).join('');
    }

    // 번호판 인식 정확도 테스트 로그 (당일 한정) — 크롭 썸네일을 함께 보여줘
    // "실제 번호판 vs 인식된 텍스트"를 그 자리에서 눈으로 비교할 수 있게 한다.
    renderPlateTestLog(entries) {
        const el = document.getElementById('plateTestLog');
        if (!el) return;
        if (!entries || entries.length === 0) {
            el.innerHTML = '<p class="report-empty">오늘 기록이 없습니다.</p>';
            return;
        }
        el.innerHTML = entries.map(e => {
            const time = new Date(e.timestamp);
            const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            return `
                <div class="plate-test-log-item">
                    ${e.cropDataUrl ? `<img src="${e.cropDataUrl}" class="plate-test-thumb" alt="번호판 크롭">` : ''}
                    <div class="plate-test-log-info">
                        <span>${e.text || '(인식 실패)'}${e.colorLabel ? ` · ${e.colorLabel}` : ''}</span>
                        <span class="report-session-date">${timeStr}</span>
                    </div>
                </div>
            `;
        }).join('');
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