/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, ChangeEvent, useMemo } from 'react';
import { motion, AnimatePresence, useScroll, useTransform, useMotionValueEvent } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { 
  ClipboardList, 
  Pill, 
  Activity, 
  AlertCircle, 
  Send, 
  CheckCircle2, 
  Loader2, 
  FileText, 
  Plus,
  PlusCircle,
  ChevronRight,
  ChevronDown,
  Baby,
  Calendar,
  Clock,
  Users,
  Bell,
  Heart,
  Stethoscope,
  Trash2,
  Edit3,
  X,
  Search,
  Sparkles,
  MessageCircle,
  HelpCircle,
  Filter,
  BellRing,
  Upload,
  Eye,
  FileUp,
  History,
  FileImage,
  Save,
  Copy,
  Check,
  CalendarCheck,
  Image as ImageIcon
} from 'lucide-react';
import { ChildActivity, ReportSummary, ChildProfile, AppNotification, ShiftReport, ChildShiftData, VitalSignReading, LegacyReport, TemporaryMedication } from './types';
import { extractMedicalEventData, extractMedicalReportData, MedicalReportExtraction, extractAndCategorizeActivities, generateRoomSummary } from './services/geminiService';
import { db, auth } from './firebase';
import { collection, onSnapshot, doc, setDoc, deleteDoc, query, orderBy, serverTimestamp, updateDoc, addDoc, getDoc } from 'firebase/firestore';
import { signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, browserPopupRedirectResolver } from 'firebase/auth';
import Markdown from 'react-markdown';

// Constants
const getLocalDateString = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getShiftDateString = (date = new Date()) => {
  const d = new Date(date);
  if (d.getHours() < 7 || (d.getHours() === 7 && d.getMinutes() < 5)) {
    d.setDate(d.getDate() - 1);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDateBR = (dateStr: string) => {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
};

const formatVital = (value: string | undefined, suffix: string) => {
  if (!value) return '-';
  
  // Handle multiple values separated by '|' or ','
  const parts = value.split('|').map(p => p.trim()).filter(p => p);
  
  const formattedParts = parts.map(part => {
    let trimmed = part;
    
    if (suffix === '°C') {
      let rawStr = trimmed.replace(/[^0-9.,]/g, '').replace(',', '.');
      let num = parseFloat(rawStr);
      
      if (!isNaN(num)) {
        if (num >= 320 && num <= 450) {
           num = num / 10;
        }
        return `${num} ${suffix}`;
      }
    }

    if (trimmed.toLowerCase().endsWith(suffix.toLowerCase()) || 
       (suffix === '°C' && (trimmed.toLowerCase().endsWith('c') || trimmed.endsWith('º') || trimmed.endsWith('°')))) {
      if (suffix === '°C' && trimmed.toLowerCase().endsWith('c') && !trimmed.includes('°')) {
        return trimmed.slice(0, -1).trim() + '°C';
      }
      return trimmed;
    }
    return `${trimmed}${suffix}`;
  });
  
  return formattedParts.join(' | ');
};

const ROOM_OPTIONS = [
  'Tamanduá Bandeira',
  'Arara Vermelha',
  'Solar Meimei',
  'Internação Temporária'
];

const ADMIN_ROOM = 'Posto de Enfermagem';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Helper to remove undefined values before saving to Firestore
const removeUndefined = (obj: any) => {
  const newObj = { ...obj };
  Object.keys(newObj).forEach(key => {
    if (newObj[key] === undefined) {
      delete newObj[key];
    }
  });
  return newObj;
};

type Tab = 'input' | 'reports' | 'profiles' | 'notifications' | 'shift-report' | 'search';

export default function App() {
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [adminPassword, setAdminPassword] = useState('123456ic');
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [roomToAccess, setRoomToAccess] = useState('');
  const [enteredPassword, setEnteredPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [toast, setToast] = useState<{ message: string; show: boolean }>({ message: '', show: false });
  const [medicationNotificationsEnabled, setMedicationNotificationsEnabled] = useState(false);
  const [isSyncingNotifications, setIsSyncingNotifications] = useState(true);

  // Sync medication notification settings
  useEffect(() => {
    if (!isAuthReady || !user) {
      if (isAuthReady && !user) setIsSyncingNotifications(false);
      return;
    }

    const unsub = onSnapshot(doc(db, 'system_config', 'medication_alarms'), (docSnap) => {
      if (docSnap.exists()) {
        setMedicationNotificationsEnabled(docSnap.data().enabled);
      }
      setIsSyncingNotifications(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'system_config/medication_alarms');
      setIsSyncingNotifications(false);
    });
    return () => unsub();
  }, [isAuthReady, user]);

  const toggleMedicationNotifications = async () => {
    try {
      await setDoc(doc(db, 'system_config', 'medication_alarms'), {
        enabled: !medicationNotificationsEnabled,
        updatedAt: serverTimestamp(),
        updatedBy: user?.displayName || user?.email || 'Desconhecido'
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'system_config/medication_alarms');
    }
  };

  const { scrollY } = useScroll();
  const [compact, setCompact] = useState(false);
  
  useMotionValueEvent(scrollY, "change", (latest) => {
    // Increase threshold to avoid flickering at the very top
    if (latest > 80 && !compact) setCompact(true);
    else if (latest <= 30 && compact) setCompact(false);
  });

  const [loginError, setLoginError] = useState<string | null>(null);
  
  useEffect(() => {
    // Check for redirect result in case of mobile login flow
    getRedirectResult(auth, browserPopupRedirectResolver).catch((error) => {
      console.error("Redirect login error:", error);
      if (error.message && error.message.includes('initial state')) {
        setLoginError("Erro de particionamento de armazenamento (Cookies de terceiros bloqueados). Tente usar o Safari/Chrome normal, não o navegador de dentro do Instagram/Facebook, ou libere cookies de terceiros nas configurações.");
      } else {
        setLoginError(error.message);
      }
    });

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);



  const handleSelectRoom = async (room: string, overrideChildId?: string) => {
    if (room === 'Internação Temporária' && !overrideChildId) {
      setPendingInternacao(true);
      return;
    }
    
    setPendingInternacao(false);
    setMyActiveRoom(room);
    if (overrideChildId) {
      setInternedChildId(overrideChildId);
    } else {
      setInternedChildId('');
    }
    
    // Check if we should show the important info modal with info from the PREVIOUS shift report
    if (room !== ADMIN_ROOM) {
      // Find the most recent shift report for this room in the already synced state
      const lastReport = shiftReports.find(r => r.room === room);
      
      const lastDismissedId = localStorage.getItem('lastDismissedImportantInfoId');
      
      const nowForSummary = new Date();
      const summaryShiftDate = new Date(nowForSummary);
      // Change shift at 07:05 AM
      if (summaryShiftDate.getHours() < 7 || (summaryShiftDate.getHours() === 7 && summaryShiftDate.getMinutes() < 5)) {
        summaryShiftDate.setDate(summaryShiftDate.getDate() - 1);
      }
      const shiftDateStr = summaryShiftDate.toLocaleDateString('pt-BR').replace(/\//g, '-');
      const currentCacheId = `${room}-${overrideChildId || 'none'}-summary-${shiftDateStr}`;
      
      if (lastDismissedId !== currentCacheId) {
        setIsImportantInfoModalOpen(true);
        setIsGeneratingSummary(true);
        setImportantInfoId(currentCacheId);
        
        try {
          // Check if summary is already cached
          const cachedDoc = await getDoc(doc(db, 'roomSummaries', currentCacheId));
          if (cachedDoc.exists() && cachedDoc.data().content) {
            setImportantInfoContent(cachedDoc.data().content);
          } else {
            const roomProfiles = profiles.filter(p => overrideChildId ? p.id === overrideChildId : p.room === room);
            const childrenNames = roomProfiles.map(p => p.name);
            
            // Gather activities from the last 36 hours to ensure full context of the previous shift
            const cutoffTime = new Date(nowForSummary.getTime() - 36 * 60 * 60 * 1000);
            
            const roomActivities = activities.filter(a => childrenNames.includes(a.childName) && new Date(a.timestamp) >= cutoffTime).map(a => ({
              childName: a.childName,
              timestamp: new Date(a.timestamp),
              description: a.description
            }));
            
            const roomTemporaryMedications = roomProfiles
              .filter(p => Array.isArray(p.temporaryMedications) && p.temporaryMedications.length > 0)
              .map(p => ({
                childName: p.name,
                medications: p.temporaryMedications!
              }));

            const recentLegacyReports = legacyReports
              .filter(lr => lr.aiAnalysis)
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .slice(0, 3)
              .map(lr => `Data: ${new Date(lr.date).toLocaleDateString('pt-BR')}\nAnálise:\n${lr.aiAnalysis}`);

            const summary = await generateRoomSummary(room, lastReport, roomActivities, childrenNames, roomTemporaryMedications, recentLegacyReports);
            setImportantInfoContent(summary);
            
            // Save to cache
            try {
              await setDoc(doc(db, 'roomSummaries', currentCacheId), {
                content: summary,
                createdAt: serverTimestamp()
              });
            } catch (e) {
              console.error("Firestore error saving summary:", e);
            }
          }
        } catch (error) {
          console.error("Erro ao gerar resumo da enfermaria:", error);
          setImportantInfoContent("Não foi possível gerar um resumo usando Inteligência Artificial no momento. Por favor, cheque os relatórios do plantão anterior manualmente.");
        } finally {
          setIsGeneratingSummary(false);
        }
      }
    }
  };

  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setLoginError(null);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({
      prompt: 'select_account'
    });
    try {
      await signInWithPopup(auth, provider, browserPopupRedirectResolver);
    } catch (error: any) {
      if (error.code !== 'auth/cancelled-popup-request' && error.code !== 'auth/popup-closed-by-user') {
        console.error("Error logging in:", error);
        setLoginError(error.message + " (Tente liberar cookies de terceiros ou usar outro navegador se estiver no Safari/Instagram)");
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const [activities, setActivities] = useState<ChildActivity[]>([]);
  const [profiles, setProfiles] = useState<ChildProfile[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [shiftReports, setShiftReports] = useState<ShiftReport[]>([]);
  const [vitalSigns, setVitalSigns] = useState<VitalSignReading[]>([]);
  const [legacyReports, setLegacyReports] = useState<LegacyReport[]>([]);
  
  const [inputText, setInputText] = useState('');
  const [selectedChildForEvent, setSelectedChildForEvent] = useState<string>('');
  const [selectedRoomForMeds, setSelectedRoomForMeds] = useState<string>('');
  const [selectedRoomForVitals, setSelectedRoomForVitals] = useState<string>('');
  const [isMedsOpen, setIsMedsOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<ChildActivity | null>(null);
  const [isEditingActivity, setIsEditingActivity] = useState(false);
  const [editActivityText, setEditActivityText] = useState('');
  const [activityToDelete, setActivityToDelete] = useState<string | null>(null);

  const handleDeleteActivity = (id: string) => {
    setActivityToDelete(id);
  };

  const confirmDeleteActivity = async () => {
    if (!activityToDelete) return;
    try {
      if (user) {
        await deleteDoc(doc(db, 'activities', activityToDelete));
      } else {
        setActivities(activities.filter(a => a.id !== activityToDelete));
      }
      setSelectedActivity(null);
      setActivityToDelete(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `activities/${activityToDelete}`);
    }
  };

  const handleUpdateActivity = async () => {
    if (!selectedActivity || !editActivityText.trim()) return;
    
    try {
      if (user) {
        await updateDoc(doc(db, 'activities', selectedActivity.id), {
          description: editActivityText.trim()
        });
      } else {
        setActivities(activities.map(a => a.id === selectedActivity.id ? { ...a, description: editActivityText.trim() } : a));
      }
      setIsEditingActivity(false);
      setSelectedActivity(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `activities/${selectedActivity.id}`);
    }
  };
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('input');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    if (window.innerWidth >= 768) return;

    let baseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

    const checkKeyboard = () => {
      const currentHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      
      if (currentHeight > baseHeight) {
        baseHeight = currentHeight;
      }

      // Se a altura encolher mais de 150px, assumimos que o teclado abriu
      const isKeyboardUp = currentHeight < baseHeight - 150;
      setIsKeyboardVisible(isKeyboardUp);

      if (isKeyboardUp) {
        const activeEl = document.activeElement as HTMLElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            setTimeout(() => {
                const header = document.querySelector('header');
                const offset = header ? header.offsetHeight + 10 : 80;
                const elementRect = activeEl.getBoundingClientRect();
                const absoluteTop = elementRect.top + window.pageYOffset;
                
                window.scrollTo({
                  top: absoluteTop - offset,
                  behavior: 'smooth'
                });
            }, 300);
        }
      }
    };

    const handleScroll = () => {
      checkKeyboard();
    };

    window.addEventListener('resize', checkKeyboard);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('touchmove', handleScroll, { passive: true });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', checkKeyboard);
      window.visualViewport.addEventListener('scroll', handleScroll);
    }
    
    document.addEventListener('focusin', () => setTimeout(checkKeyboard, 150));
    document.addEventListener('focusout', () => setTimeout(checkKeyboard, 150));

    checkKeyboard();

    return () => {
       window.removeEventListener('resize', checkKeyboard);
       window.removeEventListener('scroll', handleScroll);
       window.removeEventListener('touchmove', handleScroll);
       
       if (window.visualViewport) {
         window.visualViewport.removeEventListener('resize', checkKeyboard);
         window.visualViewport.removeEventListener('scroll', handleScroll);
       }
    };
  }, []);
  const isMainTab = activeTab === 'input';
  const isCompactHeader = compact || !isMainTab || isKeyboardVisible;

  const headerPadding = useTransform(scrollY, [0, 60], ['1.5rem', '0.25rem']);
  const logoScale = useTransform(scrollY, [0, 60], [1, 0.8]);
  const titleSize = useTransform(scrollY, [0, 60], ['1.875rem', '1.25rem']);
  const profileScale = useTransform(scrollY, [0, 60], [1, 0.8]);
  const buttonPadding = useTransform(scrollY, [0, 60], ['0.75rem', '0rem']);
  const hideOnScroll = useTransform(scrollY, [0, 40], [1, 0]);
  const betaHeight = useTransform(scrollY, [0, 40], ['16px', '0px']);
  const betaMargin = useTransform(scrollY, [0, 40], ['4px', '0px']);
  const subtitleHeight = useTransform(scrollY, [0, 40], ['1.25rem', '0rem']);
  const [notificationTab, setNotificationTab] = useState<'current' | 'archived'>('current');
  const [medicalRequestsTab, setMedicalRequestsTab] = useState<'current' | 'archived'>('current');
  
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeTab]);

  const [profileViewMode, setProfileViewMode] = useState<'grid' | 'list'>('list');
  const [profileFilterRoom, setProfileFilterRoom] = useState<string>('all');
  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);
  const [reportToDelete, setReportToDelete] = useState<ShiftReport | null>(null);
  const [notifToDelete, setNotifToDelete] = useState<AppNotification | null>(null);
  const [profileToDelete, setProfileToDelete] = useState<ChildProfile | null>(null);
  const [myActiveRoom, setMyActiveRoom] = useState<string>('');
  const [internedChildId, setInternedChildId] = useState<string>('');
  const [pendingInternacao, setPendingInternacao] = useState(false);
  const [autoReportParams, setAutoReportParams] = useState({ date: getShiftDateString(), room: '', staff: '', generalInfo: '' });
  const [expandedChildIndex, setExpandedChildIndex] = useState<number | null>(null);
  
  useEffect(() => {
    if (myActiveRoom && myActiveRoom !== ADMIN_ROOM) {
      setSelectedRoomForMeds(myActiveRoom);
      setSelectedRoomForVitals(myActiveRoom);
      
      const lastReport = shiftReports
        .filter(r => r.room === myActiveRoom)
        .sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
        
      setAutoReportParams(prev => ({ 
        ...prev, 
        room: myActiveRoom, 
        staff: prev.staff || lastReport?.staff || '' 
      }));
      
      // Auto-open if there are meds scheduled
      const meds = getRoomMedications(myActiveRoom);
      if (meds.scheduled.length > 0 || meds.temporary.length > 0) {
        setIsMedsOpen(true);
      }
    }
  }, [myActiveRoom, profiles, shiftReports]); // profiles included to re-check if meds are added/removed

  const [activeMedicationReminders, setActiveMedicationReminders] = useState<AppNotification[]>([]);
  const [medicationJustifications, setMedicationJustifications] = useState<Record<string, string>>({});

  // Helper to check if medication is late (> 15 mins)
  const isMedicationLate = (notif: AppNotification) => {
    const now = new Date();
    const [year, month, day] = notif.date.split('-').map(Number);
    const [hours, minutes] = notif.time.split(':').map(Number);
    const scheduledTime = new Date(year, month - 1, day, hours, minutes);
    
    const diffMinutes = (now.getTime() - scheduledTime.getTime()) / (1000 * 60);
    return diffMinutes > 15;
  };

  // Helper to calculate age from birthDate
  const calculateAge = (birthDate: string) => {
    if (!birthDate) return '';
    const today = new Date();
    const birth = new Date(birthDate);
    let years = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
      years--;
    }
    
    if (years === 0) {
      let months = (today.getFullYear() - birth.getFullYear()) * 12 + (today.getMonth() - birth.getMonth());
      if (today.getDate() < birth.getDate()) {
        months--;
      }
      if (months <= 0) {
        const diffTime = Math.abs(today.getTime() - birth.getTime());
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        return `${diffDays} ${diffDays === 1 ? 'dia' : 'dias'}`;
      }
      return `${months} ${months === 1 ? 'mês' : 'meses'}`;
    }
    
    return `${years} ${years === 1 ? 'ano' : 'anos'}`;
  };

  const isShiftReportEditable = (report: ShiftReport) => {
    if (report.createdAt) {
      try {
        const reportTime = typeof report.createdAt.toMillis === 'function' 
          ? report.createdAt.toMillis() 
          : new Date(report.createdAt).getTime();
        return (Date.now() - reportTime) <= 24 * 60 * 60 * 1000;
      } catch (e) {
        return report.date === getLocalDateString();
      }
    }
    return report.date === getLocalDateString();
  };

  // Auto-generate daily medication checkout notifications
  useEffect(() => {
    if (!user || profiles.length === 0 || !medicationNotificationsEnabled) return;

    const today = new Date().toLocaleDateString('en-CA');
    const missingNotifications: any[] = [];

    profiles.forEach(profile => {
      if (!profile.specialMedications) return;
      
      profile.specialMedications.forEach(med => {
        med.times.forEach(time => {
          // Create a deterministic ID so we don't create duplicates
          const safeMedId = med.id || med.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const notifId = `med-chk-${profile.id}-${safeMedId}-${today}-${time.replace(':', '')}`;
          
          // Check for existence by ID OR by same child, medication name, date and time to prevent duplicates
          const exists = notifications.some(n => 
            n.id === notifId || 
            (n.title === profile.name && n.description === `Medicação: ${med.name}` && n.date === today && n.time === time && !n.isDeleted)
          );
          
          if (!exists) {
            // Check if the medication was created AFTER this scheduled time today
            let shouldCreate = true;
            if (med.createdAt) {
              const medCreatedAt = new Date(med.createdAt);
              const [year, month, day] = today.split('-').map(Number);
              const [hours, minutes] = time.split(':').map(Number);
              const scheduledTime = new Date(year, month - 1, day, hours, minutes);
              
              if (medCreatedAt > scheduledTime) {
                shouldCreate = false;
              }
            }

            if (shouldCreate) {
              missingNotifications.push({
                id: notifId,
                title: profile.name,
                description: `Medicação: ${med.name}`,
                date: today,
                time: time,
                type: 'medication_checkout',
                isRead: false,
                authorUid: user.uid,
                createdAt: serverTimestamp()
              });
            }
          }
        });
      });
    });

    if (missingNotifications.length > 0) {
      missingNotifications.forEach(async (notif) => {
        try {
          await setDoc(doc(db, 'notifications', notif.id), notif);
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, 'notifications/auto-gen');
        }
      });
    }
  }, [profiles, notifications, user]);

  useEffect(() => {
    if (!myActiveRoom || myActiveRoom === ADMIN_ROOM || !medicationNotificationsEnabled) {
      setActiveMedicationReminders([]);
      return;
    }

    const interval = setInterval(() => {
      const now = new Date();
      const dueReminders = notifications.filter(n => {
        if (!myActiveRoom || myActiveRoom === ADMIN_ROOM) return false;
        if (n.isRead || n.isDeleted || n.type !== 'medication_checkout') return false;
        
        // Filter by room if the user has selected one
        if (myActiveRoom) {
          const childProfile = profiles.find(p => p.name === n.title);
          if (myActiveRoom === 'Internação Temporária') {
            if (childProfile && childProfile.id !== internedChildId) return false;
          } else {
            if (childProfile && childProfile.room !== myActiveRoom) return false;
          }
        }

        const [year, month, day] = n.date.split('-').map(Number);
        const [hours, minutes] = n.time.split(':').map(Number);
        const scheduledTime = new Date(year, month - 1, day, hours, minutes);
        
        return now >= scheduledTime;
      });
      setActiveMedicationReminders(dueReminders);
    }, 10000); // Check every 10 seconds
    return () => clearInterval(interval);
  }, [notifications, profiles, myActiveRoom]);

  // Firebase Real-time Listeners
  useEffect(() => {
    if (!isAuthReady || !user) return;

    const activitiesQuery = query(collection(db, 'activities'), orderBy('timestamp', 'desc'));
    const unsubscribeActivities = onSnapshot(activitiesQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChildActivity));
      setActivities(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'activities');
    });

    const profilesQuery = query(collection(db, 'profiles'), orderBy('createdAt', 'desc'));
    const unsubscribeProfiles = onSnapshot(profilesQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChildProfile));
      setProfiles(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'profiles');
    });

    const notificationsQuery = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'));
    const unsubscribeNotifications = onSnapshot(notificationsQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AppNotification));
      setNotifications(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'notifications');
    });

    const shiftReportsQuery = query(collection(db, 'shiftReports'), orderBy('createdAt', 'desc'));
    const unsubscribeShiftReports = onSnapshot(shiftReportsQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShiftReport));
      // Deduplicate by date, room, and house to ensure UI consistency
      const uniqueData: ShiftReport[] = [];
      const seen = new Set();
      data.forEach(r => {
        const key = `${r.date}_${r.room}_${r.house}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueData.push(r);
        }
      });
      setShiftReports(uniqueData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'shiftReports');
    });

    const vitalSignsQuery = query(collection(db, 'vitalSigns'), orderBy('timestamp', 'desc'));
    const unsubscribeVitalSigns = onSnapshot(vitalSignsQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as VitalSignReading));
      setVitalSigns(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'vitalSigns');
    });

    const legacyReportsQuery = query(collection(db, 'legacy_reports'), orderBy('createdAt', 'desc'));
    const unsubscribeLegacyReports = onSnapshot(legacyReportsQuery, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LegacyReport));
      // Deduplicate by date to ensure UI consistency
      const uniqueData: LegacyReport[] = [];
      const seen = new Set();
      data.forEach(r => {
        const key = r.date;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueData.push(r);
        }
      });
      setLegacyReports(uniqueData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'legacy_reports');
    });

    return () => {
      unsubscribeActivities();
      unsubscribeProfiles();
      unsubscribeNotifications();
      unsubscribeShiftReports();
      unsubscribeVitalSigns();
      unsubscribeLegacyReports();
    };
  }, [isAuthReady, user]);

  // Shift Report Form State
  const [isShiftReportModalOpen, setIsShiftReportModalOpen] = useState(false);
  const [currentShiftReport, setCurrentShiftReport] = useState<Partial<ShiftReport>>({
    date: getShiftDateString(),
    room: ROOM_OPTIONS[0],
    house: 'Solar Meimei',
    staff: '',
    generalInfo: '',
    importantInfo: '',
    childrenData: []
  });

  // Restore Drafts
  useEffect(() => {
    try {
      const savedReportStr = localStorage.getItem('shiftReportDraft');
      const wasModalOpen = localStorage.getItem('shiftReportModalOpen');
      
      if (savedReportStr) {
        const parsedReport = JSON.parse(savedReportStr);
        if (parsedReport && Object.keys(parsedReport).length > 0) {
          // If the parsed report has data indicating they were working on it
          if (parsedReport.generalInfo || parsedReport.importantInfo || (parsedReport.childrenData && parsedReport.childrenData.length > 0)) {
            setCurrentShiftReport(parsedReport);
            if (wasModalOpen === 'true') {
              setIsShiftReportModalOpen(true);
            }
          }
        }
      }
    } catch (e) {
      console.error("Error restoring drafts:", e);
    }
  }, []);

  // Save Drafts
  useEffect(() => {
    localStorage.setItem('shiftReportDraft', JSON.stringify(currentShiftReport));
  }, [currentShiftReport]);

  useEffect(() => {
    localStorage.setItem('shiftReportModalOpen', String(isShiftReportModalOpen));
  }, [isShiftReportModalOpen]);

  // Auto-remove expired temporary medications
  useEffect(() => {
    const checkExpiredMedications = async () => {
      const now = new Date();
      let updatedAnyProfile = false;

      for (const profile of profiles) {
        if (!profile.temporaryMedications || !Array.isArray(profile.temporaryMedications) || profile.temporaryMedications.length === 0) continue;

        const currentMeds = profile.temporaryMedications;
        const remainingMeds = currentMeds.filter(med => {
          try {
            // Parse end date and time
            const [year, month, day] = med.endDate.split('-').map(Number);
            const [hours, minutes] = med.endTime.split(':').map(Number);
            const endDateTime = new Date(year, month - 1, day, hours, minutes);
            return endDateTime > now;
          } catch (e) {
            console.error("Error parsing date for medication:", med, e);
            return true; // Keep it if we can't parse it
          }
        });

        if (remainingMeds.length !== currentMeds.length) {
          updatedAnyProfile = true;
          const updatedProfile = {
            ...profile,
            temporaryMedications: remainingMeds
          };

          if (user) {
            try {
              await setDoc(doc(db, 'profiles', profile.id), updatedProfile);
            } catch (error) {
              console.error("Error auto-removing medication:", error);
            }
          } else {
            setProfiles(prev => prev.map(p => p.id === profile.id ? (updatedProfile as ChildProfile) : p));
          }
        }
      }
    };

    const interval = setInterval(checkExpiredMedications, 60000); // Every minute
    checkExpiredMedications();
    return () => clearInterval(interval);
  }, [profiles, user]);

  const [selectedReport, setSelectedReport] = useState<ShiftReport | null>(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ChildProfile | null>(null);
  const [profileForm, setProfileForm] = useState<Partial<ChildProfile>>({
    name: '',
    gender: 'M',
    birthDate: '',
    supportDevices: [],
    liquidDiet: '',
    solidDiet: '',
    medicationSchedule: '',
    sosMedications: '',
    temporaryMedications: [],
    currentMedications: [],
    recurringMedications: [],
    extracurriculars: [],
    preferences: '',
    room: ROOM_OPTIONS[0],
    weight: ''
  });

  // Recurring Medication Form State
  const [recMedName, setRecMedName] = useState('');
  const [recMedTime, setRecMedTime] = useState('');
  const [recMedTimes, setRecMedTimes] = useState<string[]>([]);

  // Special Medication Form State
  const [specMedName, setSpecMedName] = useState('');
  const [specMedTime, setSpecMedTime] = useState('');
  const [specMedTimes, setSpecMedTimes] = useState<string[]>([]);

  // Diet Form State
  const [dietDesc, setDietDesc] = useState('');
  const [dietTime, setDietTime] = useState('');
  const [dietTimes, setDietTimes] = useState<string[]>([]);

  // Temporary Medication Form State
  const [tempMedName, setTempMedName] = useState('');
  const [tempMedStartDate, setTempMedStartDate] = useState('');
  const [tempMedEndDate, setTempMedEndDate] = useState('');
  const [tempMedEndTime, setTempMedEndTime] = useState('');
  const [tempMedTime, setTempMedTime] = useState('');
  const [tempMedTimes, setTempMedTimes] = useState<string[]>([]);

  // Notification Form State
  const [isNotificationModalOpen, setIsNotificationModalOpen] = useState(false);
  const [notificationForm, setNotificationForm] = useState<Partial<AppNotification>>({
    title: '',
    description: '',
    date: '',
    startDate: '',
    endDate: '',
    time: '',
    type: 'other',
    imageUrl: ''
  });

  // Prescription State
  const [isPrescriptionModalOpen, setIsPrescriptionModalOpen] = useState(false);
  const [isLegacyReportModalOpen, setIsLegacyReportModalOpen] = useState(false);
  const [legacyReportForm, setLegacyReportForm] = useState<{
    date: string;
    content: string;
    imageUrl?: string;
    mimeType?: string;
  }>({
    date: new Date().toISOString().split('T')[0],
    content: '',
  });
  const [isAnalyzingLegacyReport, setIsAnalyzingLegacyReport] = useState(false);
  const [legacyReportAnalysis, setLegacyReportAnalysis] = useState<string | null>(null);
  const [isPrescriptionProcessing, setIsPrescriptionProcessing] = useState(false);
  const [prescriptionImage, setPrescriptionImage] = useState<string | null>(null);
  const [prescriptionMimeType, setPrescriptionMimeType] = useState<string>('');
  const [matchedProfileId, setMatchedProfileId] = useState<string | null>(null);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  // Medical Event Modal State
  const [isMedicalEventModalOpen, setIsMedicalEventModalOpen] = useState(false);
  const [medicalEventForm, setMedicalEventForm] = useState<{
    id?: string;
    type: 'medical_request' | 'medical_completed';
    childId: string;
    date: string;
    time: string;
    description: string;
  }>({
    type: 'medical_request',
    childId: '',
    date: getLocalDateString(),
    time: '',
    description: ''
  });

  // Medical Report AI State
  const [isReportAIModalOpen, setIsReportAIModalOpen] = useState(false);
  const [isImportantInfoModalOpen, setIsImportantInfoModalOpen] = useState(false);
  const [importantInfoContent, setImportantInfoContent] = useState('');
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [importantInfoId, setImportantInfoId] = useState('');
  const [isVitalSignsModalOpen, setIsVitalSignsModalOpen] = useState(false);
  const [vitalSignsForm, setVitalSignsForm] = useState({
    childId: '',
    spo2: '',
    heartRate: '',
    temperature: '',
    bloodGlucose: '',
    insulinGiven: ''
  });
  const [isReportAIProcessing, setIsReportAIProcessing] = useState(false);
  const [reportAIPreview, setReportAIPreview] = useState<MedicalReportExtraction | null>(null);
  const [reportAIImages, setReportAIImages] = useState<{ base64: string; mimeType: string }[]>([]);
  const [matchedReportProfileId, setMatchedReportProfileId] = useState<string | null>(null);

  // Report Filtering State
  const [reportSearchQuery, setReportSearchQuery] = useState('');
  const [reportFilterChildId, setReportFilterChildId] = useState<string>('all');
  const [reportFilterType, setReportFilterType] = useState<string>('all');
  const [visibleActivitiesCount, setVisibleActivitiesCount] = useState(30);

  // Shift Report Filtering State
  const [shiftReportFilterDate, setShiftReportFilterDate] = useState<string>('');
  const [shiftReportFilterResponsible, setShiftReportFilterResponsible] = useState<string>('all');

  // Search/AI States
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMessages, setSearchMessages] = useState<{ role: 'user' | 'ai', content: string }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isDeleteEventConfirmOpen, setIsDeleteEventConfirmOpen] = useState(false);
  const [deleteEventPassword, setDeleteEventPassword] = useState('');
  const [deleteEventPasswordError, setDeleteEventPasswordError] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);

  const filteredActivities = useMemo(() => {
    const filterChildName = reportFilterChildId === 'all' ? null : profiles.find(p => p.id === reportFilterChildId)?.name;
    const lowerSearchQuery = reportSearchQuery.toLowerCase();
    
    return activities.filter(activity => {
      const matchesSearch = !reportSearchQuery || 
                            activity.description.toLowerCase().includes(lowerSearchQuery) ||
                            activity.childName.toLowerCase().includes(lowerSearchQuery);
      const matchesChild = reportFilterChildId === 'all' || activity.childName === filterChildName;
      const matchesType = reportFilterType === 'all' || activity.type === reportFilterType;
      return matchesSearch && matchesChild && matchesType;
    });
  }, [activities, reportSearchQuery, reportFilterChildId, reportFilterType, profiles]);

  const filteredShiftReports = useMemo(() => {
    return shiftReports.filter(report => {
      let matchesDate = true;
      if (shiftReportFilterDate) {
        const reportDate = getLocalDateString(new Date(report.date));
        matchesDate = reportDate === shiftReportFilterDate;
      }

      let matchesResponsible = true;
      if (shiftReportFilterResponsible !== 'all') {
        matchesResponsible = report.staff === shiftReportFilterResponsible;
      }

      return matchesDate && matchesResponsible;
    });
  }, [shiftReports, shiftReportFilterDate, shiftReportFilterResponsible]);

  const uniqueShiftResponsibles = Array.from(new Set(shiftReports.map(r => r.staff).filter((staff): staff is string => !!staff))) as string[];

  const getRoomMedications = (room: string) => {
    if (!room || room === ADMIN_ROOM) return { scheduled: [], sos: [], temporary: [] };
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;
    
    const scheduled: { childName: string; medName: string; time: string; isSpecial?: boolean; isDiet?: boolean; isTemporary?: boolean; endDate?: string; endTime?: string }[] = [];
    const sos: { childName: string; medName: string }[] = [];
    const temporary: { childName: string; medName: string; endDate?: string; endTime?: string; times?: string[] }[] = [];

    profiles.filter(p => room === 'Internação Temporária' ? p.id === internedChildId : p.room === room).forEach(child => {
      // 1. Structured recurring medications
      if (child.recurringMedications) {
        child.recurringMedications.forEach(med => {
          med.times.forEach(timeStr => {
            const [hours, minutes] = timeStr.split(':').map(Number);
            const medTimeInMinutes = hours * 60 + minutes;
            
            let diff = medTimeInMinutes - currentTimeInMinutes;
            if (diff > 720) diff -= 1440;
            if (diff < -720) diff += 1440;

            if (diff >= -30 && diff <= 60) {
              scheduled.push({
                childName: child.name,
                medName: med.name,
                time: timeStr,
                isSpecial: false
              });
            }
          });
        });
      }

      // 2. Structured special medications
      if (child.specialMedications) {
        child.specialMedications.forEach(med => {
          med.times.forEach(timeStr => {
            const [hours, minutes] = timeStr.split(':').map(Number);
            const medTimeInMinutes = hours * 60 + minutes;
            
            let diff = medTimeInMinutes - currentTimeInMinutes;
            if (diff > 720) diff -= 1440;
            if (diff < -720) diff += 1440;

            if (diff >= -30 && diff <= 60) {
              scheduled.push({
                childName: child.name,
                medName: med.name,
                time: timeStr,
                isSpecial: true
              });
            }
          });
        });
      }

      // 3. Structured diet schedules
      if (child.dietSchedules) {
        child.dietSchedules.forEach(diet => {
          diet.times.forEach(timeStr => {
            const [hours, minutes] = timeStr.split(':').map(Number);
            const dietTimeInMinutes = hours * 60 + minutes;
            
            let diff = dietTimeInMinutes - currentTimeInMinutes;
            if (diff > 720) diff -= 1440;
            if (diff < -720) diff += 1440;

            if (diff >= -30 && diff <= 60) {
              scheduled.push({
                childName: child.name,
                medName: diet.description,
                time: timeStr,
                isDiet: true
              });
            }
          });
        });
      }

      // 4. Temporary Medications
      if (child.temporaryMedications && Array.isArray(child.temporaryMedications)) {
        child.temporaryMedications.forEach(tm => {
          // Always add to temporary (Atenção Contínua)
          temporary.push({ 
            childName: child.name, 
            medName: tm.description,
            endDate: tm.endDate,
            endTime: tm.endTime,
            times: tm.times
          });
          
          // Check if it has specific schedules
          if (tm.times && Array.isArray(tm.times)) {
            tm.times.forEach(timeStr => {
              const [hours, minutes] = timeStr.split(':').map(Number);
              const medTimeInMinutes = hours * 60 + minutes;
              
              let diff = medTimeInMinutes - currentTimeInMinutes;
              if (diff > 720) diff -= 1440;
              if (diff < -720) diff += 1440;

              if (diff >= -30 && diff <= 60) {
                scheduled.push({
                  childName: child.name,
                  medName: tm.description,
                  time: timeStr,
                  isTemporary: true,
                  endDate: tm.endDate,
                  endTime: tm.endTime
                });
              }
            });
          }
        });
      }
    });

    scheduled.sort((a, b) => {
      const [aH, aM] = a.time.split(':').map(Number);
      const [bH, bM] = b.time.split(':').map(Number);
      return (aH * 60 + aM) - (bH * 60 + bM);
    });

    return { scheduled, sos, temporary };
  };

  const handleSaveRawEvent = async () => {
    if (!inputText.trim() || !selectedChildForEvent) {
      alert("Por favor, selecione uma criança e digite o evento.");
      return;
    }

    setIsProcessing(true);

    try {
      const childProfile = profiles.find(p => p.id === selectedChildForEvent);
      if (!childProfile) return;

      // Extract and categorize activities using AI
      const extractedActivitiesResult = await extractAndCategorizeActivities(inputText.trim());
      const extractedActivities = Array.isArray(extractedActivitiesResult) ? extractedActivitiesResult : [];
      
      if (extractedActivities.length === 0) {
        // Fallback to a single generic activity if AI fails to find any
        const newActivity: ChildActivity = {
          id: Math.random().toString(36).substr(2, 9),
          childName: childProfile.name,
          type: 'report',
          category: 'rotina',
          description: inputText.trim(),
          timestamp: new Date().toISOString(),
          status: 'completed',
          authorUid: user?.uid || 'unknown',
          authorName: user?.displayName || user?.email || 'Desconhecido'
        };
        
        if (user) {
          try {
            await setDoc(doc(db, 'activities', newActivity.id), newActivity);
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `activities/${newActivity.id}`);
          }
        } else {
          setActivities([newActivity, ...activities]);
        }
      } else {
        const now = new Date();
        const newActivities = extractedActivities.map(ea => {
          let activityTimestamp = now.toISOString();

          return {
            id: Math.random().toString(36).substr(2, 9),
            childName: childProfile.name,
            type: 'report' as const,
            category: ea.category,
            description: ea.description,
            timestamp: activityTimestamp,
            status: 'completed' as const,
            authorUid: user?.uid || 'unknown',
            authorName: user?.displayName || user?.email || 'Desconhecido'
          };
        });

        if (user) {
          try {
            await Promise.all(newActivities.map(newActivity => 
              setDoc(doc(db, 'activities', newActivity.id), newActivity)
            ));
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, 'activitiesBatch');
          }
        } else {
          setActivities([...newActivities, ...activities]);
        }
      }

      setInputText('');
      setSelectedChildForEvent('');
      alert("Adicionado ao relatório com sucesso!");
    } catch (error) {
      console.error("Erro ao processar relato:", error);
      alert("Houve um erro ao processar seu relato com IA. Tente novamente.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmMedicalEvent = async () => {
    if (!medicalEventForm.childId || !medicalEventForm.description) return;

    const child = profiles.find(p => p.id === medicalEventForm.childId);
    
    const activityId = medicalEventForm.id || Math.random().toString(36).substr(2, 9);
    
    const activityData: any = {
      id: activityId,
      childName: child?.name || 'Novo Registro',
      type: medicalEventForm.type,
      description: medicalEventForm.description,
      timestamp: medicalEventForm.id ? activities.find(a => a.id === medicalEventForm.id)?.timestamp || new Date().toISOString() : new Date().toISOString(),
      status: 'completed',
      authorUid: user?.uid || 'unknown',
      authorName: user?.displayName || user?.email || 'Desconhecido'
    };

    if (medicalEventForm.date) activityData.appointmentDate = medicalEventForm.date;
    if (medicalEventForm.time) activityData.appointmentTime = medicalEventForm.time;

    if (user) {
      try {
        await setDoc(doc(db, 'activities', activityId), activityData);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `activities/${activityId}`);
      }
    } else {
      if (medicalEventForm.id) {
        setActivities(activities.map(a => a.id === medicalEventForm.id ? activityData : a));
      } else {
        setActivities([activityData, ...activities]);
      }
    }

    // Handle Notifications for medical requests (only for new ones for simplicity in this prototype)
    if (!medicalEventForm.id && medicalEventForm.type === 'medical_request' && medicalEventForm.date) {
      // Parse date manually to ensure local time
      const [y, m, d] = medicalEventForm.date.split('-').map(Number);
      let eventDateTime = new Date(y, m - 1, d);
      
      if (medicalEventForm.time) {
        const [hours, minutes] = medicalEventForm.time.split(':').map(Number);
        eventDateTime.setHours(hours, minutes, 0, 0);
      } else {
        // Default to early morning if no time is specified
        eventDateTime.setHours(8, 0, 0, 0);
      }
      
      const notificationTimes = [
        { hours: 48, label: '48h antes' },
        { hours: 24, label: '24h antes' }
      ];

      const newNotifications: AppNotification[] = [];

      notificationTimes.forEach(({ hours, label }) => {
        const notificationDate = new Date(eventDateTime.getTime() - hours * 60 * 60 * 1000);
        const timeStr = medicalEventForm.time ? ` às ${medicalEventForm.time}` : '';
        
        // Use local time for notification trigger
        const notifTriggerTime = `${String(notificationDate.getHours()).padStart(2, '0')}:${String(notificationDate.getMinutes()).padStart(2, '0')}`;
        
        newNotifications.push({
          id: Math.random().toString(36).substr(2, 9),
          activityId: activityId,
          title: `Lembrete (${label}): ${child?.name || 'Consulta'}`,
          description: `Agendado para ${formatDateBR(medicalEventForm.date)}${timeStr}: ${medicalEventForm.description}`,
          date: getLocalDateString(notificationDate),
          time: notifTriggerTime,
          type: 'medical',
          isRead: false,
          authorUid: user?.uid || 'unknown',
          createdAt: serverTimestamp()
        });
      });

      if (user) {
        try {
          await Promise.all(newNotifications.map(n => setDoc(doc(db, 'notifications', n.id), n)));
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, 'notificationsBatch');
        }
      } else {
        setNotifications([...(newNotifications as AppNotification[]), ...notifications]);
      }
    }

    setIsMedicalEventModalOpen(false);
    setMedicalEventForm({
      type: 'medical_request',
      childId: '',
      date: getLocalDateString(),
      time: '',
      description: ''
    });
  };

  const handleDeleteMedicalEvent = async () => {
    if (!medicalEventForm.id) return;

    if (user) {
      try {
        await deleteDoc(doc(db, 'activities', medicalEventForm.id));
        
        // Also delete associated notifications
        const associatedNotifications = notifications.filter(n => n.activityId === medicalEventForm.id);
        await Promise.all(associatedNotifications.map(n => deleteDoc(doc(db, 'notifications', n.id))));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `activities/${medicalEventForm.id}`);
      }
    } else {
      setActivities(activities.filter(a => a.id !== medicalEventForm.id));
      setNotifications(notifications.filter(n => n.activityId !== medicalEventForm.id));
    }

    setIsMedicalEventModalOpen(false);
    setMedicalEventForm({
      type: 'medical_request',
      childId: '',
      date: getLocalDateString(),
      time: '',
      description: ''
    });
  };

  const handleSaveProfile = async () => {
    if (!profileForm.name) {
      alert('Por favor, preencha o nome da criança.');
      return;
    }

    setIsProcessing(true);
    try {
      if (editingProfile) {
        const updatedProfile = { ...editingProfile, ...profileForm } as ChildProfile;
        if (user) {
          try {
            await setDoc(doc(db, 'profiles', updatedProfile.id), removeUndefined(updatedProfile));
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `profiles/${updatedProfile.id}`);
          }
        } else {
          setProfiles(profiles.map(p => p.id === editingProfile.id ? updatedProfile : p));
        }
      } else {
        const newProfile: any = {
          ...profileForm,
          id: Math.random().toString(36).substr(2, 9),
          authorUid: user?.uid || 'unknown',
          createdAt: serverTimestamp()
        };
        
        if (user) {
          try {
            await setDoc(doc(db, 'profiles', newProfile.id), removeUndefined(newProfile));
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `profiles/${newProfile.id}`);
          }
        } else {
          setProfiles([newProfile as ChildProfile, ...profiles]);
        }
      }
      setIsProfileModalOpen(false);
      setEditingProfile(null);
      setProfileForm({ 
        name: '', 
        gender: 'M',
        birthDate: '', 
        supportDevices: [], 
        liquidDiet: '', 
        solidDiet: '', 
        dietSchedules: [],
        medicationSchedule: '',
        sosMedications: '',
        temporaryMedications: [],
        weight: '',
        currentMedications: [], 
        recurringMedications: [],
        specialMedications: [],
        extracurriculars: [], 
        preferences: '',
        room: ROOM_OPTIONS[0]
      });
    } catch (error) {
      console.error("Error saving profile:", error);
      alert("Erro ao salvar o perfil. Tente novamente.");
    } finally {
      setIsProcessing(false);
    }
  };

    const getChildActivitiesSummary = (childName: string, date: string): { summaryText: string; rotinaItems: string[] } => {
    // Plantão starts at 07:05 AM on 'date' and ends at 07:05 AM on 'date + 1'
    // Use local time for shift boundaries as that's when the shift physically happens
    const shiftStart = new Date(`${date}T07:05:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000); // exactly 24h later

    const relevantActivities = activities.filter(act => {
      const actTime = new Date(act.timestamp).getTime();
      const isInShift = actTime >= shiftStart && actTime < shiftEnd;
      
      const isCheckout = act.type === 'medication' && act.description.includes('Check-out realizado');
      const isPrescriptionUpload = act.type === 'medication' && act.description.includes('Nova prescrição anexada ao perfil.');
      // Filter out raw vital signs which have their own fields
      const isVitalSign = act.description.startsWith('Sinais Vitais:');
      
      // Let special Luiza glycemia records in even if they might look like vital signs
      const isLuizaGlycemia = childName.toLowerCase().includes('luiza') && (act.type === 'glycemia' || act.type === 'report');

      const nameMatches = act.childName.toLowerCase() === childName.toLowerCase() || 
                          childName.toLowerCase().includes(act.childName.toLowerCase()) ||
                          act.childName.toLowerCase().includes(childName.toLowerCase());
                          
      const isExamReport = act.type === 'medical_completed' && act.description.includes('processado (IA)');
      const isMedicalEvent = act.type === 'medical_request' || act.type === 'medical_completed';
                          
      const d = act.description.toLowerCase();
      const isSimpleExcretion = 
        !d.includes('diarreia') && !d.includes('diarréia') &&
        (d.includes('diurese') || d.includes('urina') || d.includes('xixi') || d.includes('número 1') || d.includes('numero 1') ||
         d.includes('evacu') || d.includes('fezes') || d.includes('cocô') || d.includes('coco') || d.includes('fez o 2') || d.includes('número 2') || d.includes('numero 2') || d.includes('faz o 2') || d.includes('faz coc'));
                          
      const isExplicitGeneralState = /^estado geral/i.test(act.description.trim());

      return nameMatches && isInShift && !isCheckout && !isPrescriptionUpload && !isExamReport && !isMedicalEvent && (!isVitalSign || isLuizaGlycemia) && !isSimpleExcretion && !isExplicitGeneralState;
    });

    // ORDER: First to Last (Chronological)
    const sorted = [...relevantActivities].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // CATEGORIZATION for better organization
    const routine = sorted.filter(act => act.type !== 'glycemia');
    const glycemia = sorted.filter(act => act.type === 'glycemia');

    // Grouping routine activities by category
    const categorized = {
      alimentacao: routine.filter(a => a.category === 'alimentacao'),
      intercorrencia: routine.filter(a => a.category === 'intercorrencia'),
      sos: routine.filter(a => a.category === 'sos'),
      medicacao_rotina: routine.filter(a => a.category === 'medicacao_rotina'),
      cuidados_extras: routine.filter(a => a.category === 'cuidados_extras'),
      rotina: routine.filter(a => a.category === 'rotina' || (!a.category && a.type !== 'medication'))
    };

    // Fallback manual meds se tiverem vindo do front-end apenas como type="medication" e não tiver category ainda:
    routine.filter(a => !a.category && a.type === 'medication').forEach(med => {
      // Tenta ser inteligente no front, caso não tenha passado pela IA ainda:
      if (med.description.toLowerCase().includes('sos') || med.description.toLowerCase().includes('s.o.s')) {
        categorized.sos.push(med);
      } else {
        categorized.medicacao_rotina.push(med);
      }
    });

    let summaryText = '';
    const seenTimestamps = new Set<string>();
    
    const formatSection = (title: string, list: any[], showTime = true) => {
      if (list.length === 0) return '';
      const items = list.map(act => {
        if (!showTime) return act.description;
        const time = new Date(act.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        if (seenTimestamps.has(act.timestamp)) {
          return act.description;
        } else {
          seenTimestamps.add(act.timestamp);
          return `[${time}] ${act.description}`;
        }
      }).join('\n');
      return `\n${title}:\n${items}\n`;
    };

    summaryText += formatSection('🍼 ALIMENTAÇÃO', categorized.alimentacao, false);
    summaryText += formatSection('⚠️ INTERCORRÊNCIAS', categorized.intercorrencia);
    summaryText += formatSection('💊 MEDICAÇÕES', categorized.medicacao_rotina);
    summaryText += formatSection('💊 MEDICAÇÕES SOS', categorized.sos);
    summaryText += formatSection('➕ CUIDADOS EXTRAS', categorized.cuidados_extras);
    
    // As rotinas agora vão para o estado geral, não compõem mais o summaryText separadas
    const rotinaItems = categorized.rotina.map(act => {
      return act.description;
    });

    summaryText = summaryText.trim();
    
    let glycemiaText = '';
    const glycemiaList = [...glycemia];

    // Adição forçada para Luiza conforme solicitação (Glargina 10 UI)
    if (childName.toLowerCase().includes('luiza')) {
      const t06 = new Date(`${date}T06:00:00`).toISOString();
      glycemiaList.push({
        timestamp: t06,
        description: `*06:00=>* Adm Glargina (10 UI)`,
        type: 'glycemia'
      } as any);
    }

    // Sort all glycemia events chronologically
    glycemiaList.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    glycemiaText = glycemiaList.map(act => {
      // If it's a special record that already includes its own time format (like Luiza's NPH, Glargina, or glucose), 
      // return it directly. Otherwise, add the standard [HH:mm] prefix.
      if (act.description.startsWith('*')) return act.description;
      const time = new Date(act.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${act.description}`;
    }).join('\n');

    if (glycemiaText) {
      if (summaryText) summaryText += '\n\n';
      summaryText += `💉 GLICEMIA:\n${glycemiaText}`;
    }

    return {
      summaryText: summaryText || (sorted.filter(act => act.category !== 'rotina' && act.type !== 'glycemia').length > 0 ? sorted.filter(act => act.category !== 'rotina' && act.type !== 'glycemia').map(act => `- ${act.description}`).join('\n') : ''),
      rotinaItems
    };
  };

  const getExplicitGeneralStateFromActivities = (childName: string, date: string): string | null => {
    const shiftStart = new Date(`${date}T07:05:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000); 

    const relevantActivities = activities.filter(act => {
      const actTime = new Date(act.timestamp).getTime();
      const nameMatches = act.childName.toLowerCase() === childName.toLowerCase() || 
                          childName.toLowerCase().includes(act.childName.toLowerCase()) ||
                          act.childName.toLowerCase().includes(childName.toLowerCase());
      return actTime >= shiftStart && actTime < shiftEnd && nameMatches;
    });

    let explicitState: string | null = null;
    
    const sorted = [...relevantActivities].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    sorted.forEach(act => {
      const text = act.description;
      if (/^estado geral/i.test(text.trim())) {
        let extracted = text.trim().replace(/^estado geral[:\s-]*/i, '').trim();
        if (extracted) {
           extracted = extracted.charAt(0).toUpperCase() + extracted.slice(1);
           explicitState = extracted;
        }
      }
    });

    return explicitState;
  };

  const getGeneralStateForChild = (childName: string, date: string, activitiesSummary: string, rotinaItems: string[]): string => {
    const explicitState = getExplicitGeneralStateFromActivities(childName, date);
    
    let finalState = explicitState || '';
    
    if (rotinaItems && rotinaItems.length > 0) {
       rotinaItems.forEach(item => {
           // Basic deduplication: if the finalState already includes this exact string or similar
           const strippedItem = item.replace(/\[\d{2}:\d{2}\]/, '').trim();
           
           // Se a string da rotina for exatamente igual ou estiver contida no geral, não duplica
           if (!finalState.toLowerCase().includes(strippedItem.toLowerCase())) {
               if (finalState) {
                   finalState = finalState.trim();
                   if (finalState.endsWith('.')) {
                       finalState = finalState.slice(0, -1) + '; ';
                   } else if (!finalState.endsWith(';')) {
                       finalState += '; ';
                   } else {
                       finalState += ' ';
                   }
               }
               finalState += item;
           }
       });
    }
    
    if (!finalState) {
        finalState = 'Passou o dia e a noite bem, sem alterações.';
    }
    
    if (activitiesSummary) {
        return `${finalState}\n\n${activitiesSummary}`;
    }
    
    return finalState;
  };

  const getEvacuationAndDiuresisFromActivities = (childName: string, date: string, lastData: ChildShiftData | undefined) => {
    const shiftStart = new Date(`${date}T07:05:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000); 

    const relevantActivities = activities.filter(act => {
      const actTime = new Date(act.timestamp).getTime();
      const nameMatches = act.childName.toLowerCase() === childName.toLowerCase() || 
                          childName.toLowerCase().includes(act.childName.toLowerCase()) ||
                          act.childName.toLowerCase().includes(childName.toLowerCase());
      return actTime >= shiftStart && actTime < shiftEnd && nameMatches;
    });

    let diuresisInfo = { diuresis: 'Presente', found: false };
    let evacuationInfo = { evacuation: lastData?.evacuation || 'Ausente', found: false };

    let diureseCont = 0;
    let evacuaCont = 0;
    let evacAusente = false;
    let diureseAusente = false;
    let evacDaysStr = '';

    relevantActivities.forEach(act => {
        const desc = act.description.toLowerCase();
        if (desc.includes('diurese') || desc.includes('urina') || desc.includes('xixi') || desc.includes('número 1') || desc.includes('numero 1')) {
            diuresisInfo.found = true;
            const isNegativeDiuresis = /(ausente|n[ãa]o\s+urin|sem\s+urina|n[ãa]o\s+f[ae]z\s+(?:xixi|o\s*1))/i.test(desc);
            if (isNegativeDiuresis) diureseAusente = true;
            else diureseCont++;
        }
        if (desc.includes('evacu') || desc.includes('fezes') || desc.includes('cocô') || desc.includes('coco') || desc.includes('fez o 2') || desc.includes('número 2') || desc.includes('numero 2') || desc.includes('faz o 2') || desc.includes('faz coc')) {
            evacuationInfo.found = true;
            const isNegativeEvac = /(ausente|n[ãa]o\s+evacu|sem\s+evacua|n[ãa]o\s+f[ae]z\s+(?:coc[oô]|o\s*2))/i.test(desc);
            if (isNegativeEvac) {
                evacAusente = true;
                let matchDias = desc.match(/(\d+)\s*dias/i);
                if (matchDias) {
                    evacDaysStr = ` há ${matchDias[1]} dias`;
                } else {
                    let matchDia = desc.match(/(\d+)\s*(?:º|°|\u00B0|\u00BA|o)?\s*dia/i);
                    if (matchDia) evacDaysStr = ` (${matchDia[1]}º dia)`;
                }
            } else {
                evacuaCont++;
            }
        }
    });

    if (diuresisInfo.found) {
        if (diureseAusente && diureseCont === 0) diuresisInfo.diuresis = 'Ausente';
        else diuresisInfo.diuresis = diureseCont > 1 ? `Presente (${diureseCont}x)` : 'Presente';
    }

    if (evacuationInfo.found) {
        if (evacAusente && evacuaCont === 0) evacuationInfo.evacuation = 'Ausente' + evacDaysStr;
        else evacuationInfo.evacuation = evacuaCont > 1 ? `Presente (${evacuaCont}x)` : 'Presente';
    }

    return { 
        diuresis: diuresisInfo.found ? diuresisInfo.diuresis : 'Presente', 
        evacuation: evacuationInfo.found ? evacuationInfo.evacuation : (lastData?.evacuation || 'Ausente') 
    };
  };

  const getVitalSignsSummary = (vitals: VitalSignReading[], isInternacaoTemporaria: boolean) => {
    if (vitals.length === 0) return { spo2: '', fc: '', tax: '' };

    const sorted = [...vitals].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const formatV = (v: VitalSignReading | undefined, field: 'spo2' | 'heartRate' | 'temperature', suffix: string) => {
      if (!v) return null;
      const val = (v as any)[field];
      if (!val) return null;
      const formattedVal = formatVital(val, suffix);
      const timeStr = new Date(v.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return `[${timeStr}h] ${formattedVal}`;
    };

    if (isInternacaoTemporaria) {
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const pool18to21 = sorted.filter(v => {
        const h = new Date(v.timestamp).getHours();
        return h >= 18 && h < 21;
      });
      const intermediate = pool18to21.length > 0 
        ? pool18to21[Math.floor(Math.random() * pool18to21.length)] 
        : null;

      const assemble = (field: 'spo2' | 'heartRate' | 'temperature', suffix: string) => {
        const readings = [first, intermediate, last].filter(Boolean) as VitalSignReading[];
        const uniqueIds = Array.from(new Set(readings.map(r => r.id)));
        const uniqueReadings = uniqueIds.map(id => readings.find(r => r.id === id)).filter(Boolean) as VitalSignReading[];
        
        return uniqueReadings
          .map(r => formatV(r, field, suffix))
          .filter(Boolean)
          .join(' | ');
      };

      return {
        spo2: assemble('spo2', '%'),
        fc: assemble('heartRate', 'BPM'),
        tax: assemble('temperature', '°C')
      };
    } else {
      const desc = [...sorted].reverse();
      const vSpo2 = desc.find(v => v.spo2);
      const vFc = desc.find(v => v.heartRate);
      const vTax = desc.find(v => v.temperature);

      return {
        spo2: formatV(vSpo2, 'spo2', '%') || '',
        fc: formatV(vFc, 'heartRate', 'BPM') || '',
        tax: formatV(vTax, 'temperature', '°C') || ''
      };
    }
  };

  const handleEditShiftReport = (report: ShiftReport) => {
    setExpandedChildIndex(null);
    setCurrentShiftReport(populateVitalsForReport(report));
    setIsShiftReportModalOpen(true);
  };

  const populateVitalsForReport = (reportData: Partial<ShiftReport>) => {
    if (!reportData.childrenData || !reportData.date) return reportData;

    const shiftStart = new Date(`${reportData.date}T07:00:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000); 
    
    const newChildrenData = reportData.childrenData.map(child => {
      const shiftVitals = vitalSigns
        .filter(v => v.childId === child.childId)
        .filter(v => {
           const t = new Date(v.timestamp).getTime();
           return t >= shiftStart && t <= shiftEnd + (5 * 60 * 1000); // 5 min buffer
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        
      const vitalsSummary = getVitalSignsSummary(shiftVitals, false);

      if (shiftVitals.length > 0) {
        return {
          ...child,
          spo2: vitalsSummary.spo2 || child.spo2 || '',
          fc: vitalsSummary.fc || child.fc || '',
          tax: vitalsSummary.tax || child.tax || ''
        };
      }
      return child;
    });
    
    return { ...reportData, childrenData: newChildrenData };
  };

  const refreshChildShiftData = (index: number) => {
    if (!currentShiftReport || !currentShiftReport.childrenData || !currentShiftReport.date) return;
    
    const child = currentShiftReport.childrenData[index];
    const activitiesSummary = getChildActivitiesSummary(child.childName, currentShiftReport.date);
    
    const newGeneralState = getGeneralStateForChild(child.childName, currentShiftReport.date, activitiesSummary.summaryText, activitiesSummary.rotinaItems);

    const shiftStart = new Date(`${currentShiftReport.date}T07:00:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000); 

    const shiftVitals = vitalSigns
      .filter(v => v.childId === child.childId)
      .filter(v => {
         const t = new Date(v.timestamp).getTime();
         return t >= shiftStart && t <= shiftEnd + (5 * 60 * 1000); // 5 min buffer
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const vitalsSummary = getVitalSignsSummary(shiftVitals, currentShiftReport.room === 'Internação Temporária');
      
    const lastDataInfo = lastReportForChild(child.childName, currentShiftReport.date);
    const { diuresis, evacuation } = getEvacuationAndDiuresisFromActivities(child.childName, currentShiftReport.date, lastDataInfo);

    const newChildrenData = [...currentShiftReport.childrenData];
    newChildrenData[index] = {
      ...child,
      generalState: newGeneralState,
      spo2: vitalsSummary.spo2 || child.spo2 || '',
      fc: vitalsSummary.fc || child.fc || '',
      tax: vitalsSummary.tax || child.tax || '',
      diuresis: diuresis,
      evacuation: evacuation
    };
    
    setCurrentShiftReport({ ...currentShiftReport, childrenData: newChildrenData });
  };

  const lastReportForChild = (childName: string, date: string): ChildShiftData | undefined => {
    let lastData: ChildShiftData | undefined;
    for (let i = 0; i < shiftReports.length; i++) {
      if (shiftReports[i].date < date) {
        const found = shiftReports[i].childrenData?.find(cd => cd.childName === childName);
        if (found) {
          lastData = found;
          break;
        }
      }
    }
    return lastData;
  };


  const handleSaveShiftReport = async () => {
    if (!currentShiftReport.date || !currentShiftReport.room) return;

    setIsProcessing(true);
    const currentStaffName = user?.displayName || 'Sistema';
    
    // Create a deterministic ID based on date, room and house to prevent duplicates
    const dateSlug = (currentShiftReport.date || '').replace(/[^a-z0-9]/gi, '-');
    const roomSlug = (currentShiftReport.room || '').toLowerCase().replace(/[^a-z0-9]/gi, '-');
    const houseSlug = (currentShiftReport.house || '').toLowerCase().replace(/[^a-z0-9]/gi, '-');
    const deterministicId = currentShiftReport.id || `shift_${houseSlug}_${roomSlug}_${dateSlug}`;

    try {
      // Editing existing report OR overwriting duplicate by using the same ID
      const updatedReport = { 
        ...currentShiftReport, 
        id: deterministicId, 
        staff: currentStaffName,
        authorUid: currentShiftReport.authorUid || user?.uid || 'unknown',
        createdAt: currentShiftReport.createdAt || serverTimestamp()
      } as ShiftReport;
      
      if (user) {
        try {
          await setDoc(doc(db, 'shiftReports', deterministicId), removeUndefined(updatedReport));
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `shiftReports/${deterministicId}`);
        }
      } else {
        const index = shiftReports.findIndex(r => r.id === deterministicId);
        if (index >= 0) {
          const newReports = [...shiftReports];
          newReports[index] = updatedReport;
          setShiftReports(newReports);
        } else {
          setShiftReports([updatedReport, ...shiftReports]);
        }
      }

      setIsShiftReportModalOpen(false);
      setCurrentShiftReport({
        date: getShiftDateString(),
        room: ROOM_OPTIONS[0],
        house: 'Solar Meimei',
        staff: '',
        generalInfo: '',
        importantInfo: '',
        childrenData: []
      });
    } catch (error) {
      console.error("Error saving shift report:", error);
      alert("Erro ao salvar o relatório. Tente novamente.");
    } finally {
      setIsProcessing(false);
    }
  };

  const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 800;
          const MAX_HEIGHT = 800;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.onerror = (error) => reject(error);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handlePrescriptionUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsPrescriptionProcessing(true);
    setMatchedProfileId(null);

    try {
      const compressedDataUrl = await compressImage(file);
      const base64 = compressedDataUrl.split(',')[1];
      const mimeType = compressedDataUrl.split(';')[0].split(':')[1];
      setPrescriptionImage(base64);
      setPrescriptionMimeType(mimeType);
    } catch (error) {
      console.error("Erro ao processar imagem:", error);
      alert("Erro ao processar a imagem. Tente novamente.");
    } finally {
      setIsPrescriptionProcessing(false);
    }
  };

  const handleLegacyReportImageUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsAnalyzingLegacyReport(true);
    try {
      const compressedDataUrl = await compressImage(file);
      const base64 = compressedDataUrl.split(',')[1];
      const mimeType = compressedDataUrl.split(';')[0].split(':')[1];
      setLegacyReportForm(prev => ({ 
        ...prev, 
        imageUrl: base64, 
        mimeType: mimeType 
      }));
    } catch (error) {
      console.error("Erro ao processar imagem para relatório legado:", error);
      alert("Erro ao processar a imagem.");
    } finally {
      setIsAnalyzingLegacyReport(false);
    }
  };

  const analyzeLegacyReport = async () => {
    if (!legacyReportForm.content && !legacyReportForm.imageUrl) {
      alert("Por favor, adicione texto ou uma imagem para analisar.");
      return;
    }

    setIsAnalyzingLegacyReport(true);
    setLegacyReportAnalysis(null);
    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY não configurado.");
      }
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const prompt = `Você é um assistente de enfermagem especializado em cuidados de crianças especiais. 
      Analise este relatório de plantão (texto ou imagem) da enfermaria e extraia informações críticas de forma estruturada.
      
      FOQUE EM:
      - Ocorrências principais no plantão
      - Sinais vitais anormais ou alertas
      - Medicamentos administrados (especiais ou SOS)
      - Alimentação (GTT, SNE, Oral) e intercorrências
      - Observações comportamentais relevantes das crianças
      
      Responda em Português do Brasil com um resumo técnico, estruturado e profissional. 
      Agrupe as informações por criança (pelo nome), relatando os eventos de cada uma. Se for um evento geral da enfermaria, crie uma seção "Geral".
      A data do relatório é: ${legacyReportForm.date}`;
      
      const parts: any[] = [{ text: prompt }];
      
      if (legacyReportForm.content) {
        parts.push({ text: `CONTEÚDO TEXTUAL DO RELATÓRIO:\n${legacyReportForm.content}` });
      }
      
      if (legacyReportForm.imageUrl) {
        parts.push({ 
          inlineData: { 
            data: legacyReportForm.imageUrl, 
            mimeType: legacyReportForm.mimeType || 'image/jpeg' 
          } 
        });
      }

      const response = await ai.models.generateContent({ 
        model: "gemini-3-flash-preview",
        contents: { parts }
      });
      
      const text = response.text || "";
      setLegacyReportAnalysis(text);
    } catch (error) {
      console.error("Erro na análise da IA:", error);
      alert("Houve um erro de permissão (403). Verifique se você configurou sua GEMINI_API_KEY corretamente na aba Settings > Secrets do AI Studio.");
    } finally {
      setIsAnalyzingLegacyReport(false);
    }
  };

   const saveLegacyReport = async () => {
    if (!legacyReportAnalysis && !legacyReportForm.content && !legacyReportForm.imageUrl) return;

    try {
      setIsAnalyzingLegacyReport(true);
      
      // Deterministic ID based on date to prevent duplicates
      const dateSlug = (legacyReportForm.date || '').replace(/[^a-z0-9]/gi, '-');
      const deterministicId = `legacy_${dateSlug}`;
      
      const docData = {
        id: deterministicId,
        date: legacyReportForm.date,
        content: legacyReportForm.content || '',
        imageUrl: legacyReportForm.imageUrl ? `data:${legacyReportForm.mimeType || 'image/jpeg'};base64,${legacyReportForm.imageUrl}` : undefined,
        aiAnalysis: legacyReportAnalysis || undefined,
        authorUid: user?.uid || 'anonymous',
        createdAt: serverTimestamp(),
      };
      
      if (user) {
        try {
          await setDoc(doc(db, 'legacy_reports', deterministicId), removeUndefined(docData));
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `legacy_reports/${deterministicId}`);
        }
      }
      
      setIsLegacyReportModalOpen(false);
      setLegacyReportForm({ date: new Date().toISOString().split('T')[0], content: '' });
      setLegacyReportAnalysis(null);
      alert("Histórico legado importado e analisado com sucesso!");
    } catch (error) {
      console.error("Erro ao salvar relatório legado:", error);
      alert("Erro ao salvar relatório no banco de dados.");
    } finally {
      setIsAnalyzingLegacyReport(false);
    }
  };

  const handleConfirmPrescription = async () => {
    if (!prescriptionImage || !matchedProfileId) return;
    setIsPrescriptionProcessing(true);
    try {
      const profileToUpdate = profiles.find(p => p.id === matchedProfileId);
      if (!profileToUpdate) return;

      const updatedProfile = {
        ...profileToUpdate,
        latestPrescriptionImage: `data:${prescriptionMimeType};base64,${prescriptionImage}`
      };

      if (user) {
        try {
          await updateDoc(doc(db, 'profiles', matchedProfileId), {
            latestPrescriptionImage: updatedProfile.latestPrescriptionImage
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `profiles/${matchedProfileId}`);
        }
      } else {
        setProfiles(profiles.map(p => p.id === matchedProfileId ? updatedProfile : p));
      }

      const newActivity: ChildActivity = {
        id: Math.random().toString(36).substr(2, 9),
        childName: profileToUpdate.name,
        type: 'medication',
        description: `Nova prescrição anexada ao perfil.`,
        timestamp: new Date().toISOString(),
        status: 'completed',
        authorUid: user?.uid || 'unknown',
        authorName: user?.displayName || user?.email || 'Desconhecido'
      };
      
      if (user) {
        try {
          await setDoc(doc(db, 'activities', newActivity.id), newActivity);
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `activities/${newActivity.id}`);
        }
      } else {
        setActivities([newActivity, ...activities]);
      }

      setIsPrescriptionModalOpen(false);
      setPrescriptionImage(null);
      setMatchedProfileId(null);
    } catch (error) {
      console.error("Erro ao salvar prescrição:", error);
      alert("Erro ao salvar a prescrição. Verifique sua conexão e tente novamente.");
    } finally {
      setIsPrescriptionProcessing(false);
    }
  };

  const handleSaveVitalSigns = async () => {
    if (!vitalSignsForm.childId) {
      alert('Selecione uma criança.');
      return;
    }

    const profile = profiles.find(p => p.id === vitalSignsForm.childId);
    if (!profile) return;

    setIsProcessing(true);
    try {
      const newReading: VitalSignReading = {
        id: Math.random().toString(36).substr(2, 9),
        childId: profile.id,
        childName: profile.name,
        spo2: vitalSignsForm.spo2,
        heartRate: vitalSignsForm.heartRate,
        temperature: vitalSignsForm.temperature,
        bloodGlucose: vitalSignsForm.bloodGlucose,
        insulinDoseGiven: vitalSignsForm.insulinGiven,
        timestamp: new Date().toISOString(),
        authorUid: user?.uid || 'unknown',
        authorName: user?.displayName || user?.email || 'Desconhecido'
      };

      if (user) {
        try {
          await setDoc(doc(db, 'vitalSigns', newReading.id), removeUndefined(newReading));
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `vitalSigns/${newReading.id}`);
        }
      } else {
        setVitalSigns([newReading, ...vitalSigns]);
      }

      // Also add to activities for visibility (skip for Luiza if it's ONLY glucose, as special summary will handle it)
      const hasOtherVitals = vitalSignsForm.spo2 || vitalSignsForm.heartRate || vitalSignsForm.temperature;
      const isLuizaOnlyGlucose = profile.name.toLowerCase().includes('luiza') && !hasOtherVitals && vitalSignsForm.bloodGlucose;

      if (!isLuizaOnlyGlucose) {
        let activityDesc = `Sinais Vitais: SpO2: ${vitalSignsForm.spo2 || '-'}%, FC: ${vitalSignsForm.heartRate || '-'} bpm, Tax: ${vitalSignsForm.temperature || '-'}°C`;
        if (vitalSignsForm.bloodGlucose) activityDesc += `, Glicemia: ${vitalSignsForm.bloodGlucose} mg/dL`;
        if (vitalSignsForm.insulinGiven) activityDesc += ` (Insulina: ${vitalSignsForm.insulinGiven} UI)`;
        
        const newActivity: ChildActivity = {
          id: Math.random().toString(36).substr(2, 9),
          childName: profile.name,
          type: 'activity',
          description: activityDesc,
          timestamp: new Date().toISOString(),
          status: 'completed',
          authorUid: user?.uid || 'unknown',
          authorName: user?.displayName || user?.email || 'Desconhecido'
        };

        if (user) {
          try {
            await setDoc(doc(db, 'activities', newActivity.id), newActivity);
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `activities/${newActivity.id}`);
          }
        } else {
          setActivities([newActivity, ...activities]);
        }
      }

      // Special handling for Luiza's blood glucose observation
      if (vitalSignsForm.bloodGlucose && profile.name.toLowerCase().includes('luiza')) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const correction = vitalSignsForm.insulinGiven ? `${vitalSignsForm.insulinGiven}UI` : "sem correção";
        const authorName = user?.displayName || user?.email || 'Desconhecido';
        const luizaObservation = `*${timeStr}=>* ${vitalSignsForm.bloodGlucose}mg/dL - ${correction}`;
        
        const luizaReportActivity: ChildActivity = {
          id: Math.random().toString(36).substr(2, 9),
          childName: profile.name,
          type: 'glycemia',
          description: luizaObservation,
          timestamp: now.toISOString(),
          status: 'completed',
          authorUid: user?.uid || 'unknown',
          authorName: user?.displayName || user?.email || 'Desconhecido'
        };

        if (user) {
          try {
            await setDoc(doc(db, 'activities', luizaReportActivity.id), luizaReportActivity);
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `activities/${luizaReportActivity.id}`);
          }
        } else {
          setActivities(prev => [luizaReportActivity, ...prev]);
        }
      }

      setIsVitalSignsModalOpen(false);
      setVitalSignsForm({
        childId: '',
        spo2: '',
        heartRate: '',
        temperature: '',
        bloodGlucose: '',
        insulinGiven: ''
      });
    } catch (error) {
      console.error("Erro ao salvar sinais vitais:", error);
      alert("Erro ao salvar os sinais vitais. Tente novamente.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReportAIUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsReportAIProcessing(true);
    setReportAIPreview(null);
    setMatchedReportProfileId(null);
    setReportAIImages([]);

    try {
      const processedImages: { base64: string; mimeType: string }[] = [];
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const compressedDataUrl = await compressImage(file);
        const base64 = compressedDataUrl.split(',')[1];
        const mimeType = compressedDataUrl.split(';')[0].split(':')[1];
        processedImages.push({ base64, mimeType });
      }

      setReportAIImages(processedImages);

      const data = await extractMedicalReportData(processedImages);
      setReportAIPreview(data);
      
      const matched = profiles.find(p => 
        p.name.toLowerCase().includes(data.patientName.toLowerCase()) || 
        data.patientName.toLowerCase().includes(p.name.toLowerCase())
      );
      if (matched) {
        setMatchedReportProfileId(matched.id);
      }
    } catch (error) {
      console.error("Erro ao processar relatório:", error);
      alert("Erro ao processar as imagens. Tente novamente.");
    } finally {
      setIsReportAIProcessing(false);
    }
  };

  const handleConfirmReportAI = async () => {
    if (!reportAIPreview || !matchedReportProfileId) return;

    setIsReportAIProcessing(true);
    try {
      const profileToUpdate = profiles.find(p => p.id === matchedReportProfileId);
      if (!profileToUpdate) return;

      const authorName = user?.displayName || user?.email || 'Desconhecido';
      const newActivity: ChildActivity = {
        id: Math.random().toString(36).substr(2, 9),
        childName: profileToUpdate.name,
        type: 'medical_completed',
        description: `Relatório de ${reportAIPreview.reportType} processado (IA). Achados: ${reportAIPreview.findings}`,
        timestamp: new Date().toISOString(),
        status: 'completed',
        authorUid: user?.uid || 'unknown',
        authorName: authorName
      };

      if (user) {
        try {
          await setDoc(doc(db, 'activities', newActivity.id), newActivity);
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `activities/${newActivity.id}`);
        }
      } else {
        setActivities([newActivity, ...activities]);
      }

      setIsReportAIModalOpen(false);
      setReportAIPreview(null);
      setReportAIImages([]);
      setMatchedReportProfileId(null);
    } catch (error) {
      console.error("Erro ao confirmar relatório:", error);
      alert("Erro ao salvar os dados. Tente novamente.");
    } finally {
      setIsReportAIProcessing(false);
    }
  };

  const getGlycemicControlLog = (childId: string, childName: string, date: string) => {
    // Buscar aferições de sinais vitais
    const vitals = vitalSigns.filter(v => 
      v.childId === childId && 
      (v.bloodGlucose || v.insulinDoseGiven) && 
      getLocalDateString(new Date(v.timestamp)) === date
    ).map(v => {
      const time = new Date(v.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      if (v.bloodGlucose) {
        const ins = v.insulinDoseGiven ? `(${v.insulinDoseGiven} UI)` : 'sem correção';
        return { timestamp: new Date(v.timestamp).getTime(), text: `- ${time}h: ${v.bloodGlucose} ${ins}` };
      } else {
        return { timestamp: new Date(v.timestamp).getTime(), text: `- ${time}h: Adm Insulina (${v.insulinDoseGiven} UI)` };
      }
    });

    const nphActivities: { timestamp: number; text: string }[] = [];
    const profile = profiles.find(p => p.id === childId);

    // Procura NPH nos medicamentos especiais/recorrentes do perfil
    if (profile) {
      const allMedications = [...(profile.recurringMedications || []), ...(profile.specialMedications || [])];
      const nphMeds = allMedications.filter(med => med.name.toLowerCase().includes('nph'));
      
      nphMeds.forEach(med => {
        let doseMatch = med.name.match(/(\d+\s*UI)/i) || med.name.match(/(\d+\s*ui)/i) || med.name.match(/(\d+)/i);
        let doseInfo = doseMatch ? `(${doseMatch[1].toUpperCase()}${!doseMatch[1].toLowerCase().includes('ui') ? ' UI' : ''})` : '';
        
        med.times.forEach(timeStr => { // timeStr no formato "HH:MM"
          const parsedDate = new Date(date + 'T' + timeStr + ':00'); // Assuming date is "YYYY-MM-DD"
          
          let logTimeMillis;
          // Format date if needed, date arg is from getLocalDateString which is YYYY-MM-DD
          if (!isNaN(parsedDate.getTime())) {
            logTimeMillis = parsedDate.getTime();
          } else {
            // fallback
            const [hours, minutes] = timeStr.split(':').map(Number);
            const ts = new Date().setHours(hours, minutes, 0, 0);
            logTimeMillis = ts;
          }
          
          nphActivities.push({
            timestamp: logTimeMillis,
            text: `- ${timeStr}h: Adm NPH ${doseInfo}`.trim()
          });
        });
      });
    }

    const combined = [...vitals, ...nphActivities].sort((a, b) => a.timestamp - b.timestamp);
    if (combined.length === 0) return '';

    // Remove text duplicates (in development they might overlap if multiple nphs fall inline)
    const uniqueCombined = combined.filter((v, i, a) => a.findIndex(t => t.text === v.text) === i);

    let result = `*Controle Glicêmico:*\n`;
    uniqueCombined.forEach(item => {
      result += `${item.text}\n`;
    });
    return result + `\n`;
  };

  const formatShiftReportForWhatsApp = (report: ShiftReport) => {
    let text = `*Bom dia!*\n`;
    text += `_Data:_ ${formatDateBR(report.date)}\n`;
    text += `_${report.room}_\n\n`;

    report.childrenData.forEach(child => {
      text += `${child.childName.toUpperCase()}\n\n`;
      text += `*Estado Geral:*\n${child.generalState}\n\n`;
      
      if (child.feeding) text += `*Dietas:* ${child.feeding}\n`;
      if (child.water) text += `*Água:* ${child.water}\n\n`;
      
      text += `*Diurese:* ${child.diuresis}\n`;
      text += `*Evacuação:* ${child.evacuation}\n\n`;
      
      const childNameLower = child.childName.toLowerCase();
      const isUnmonitored = childNameLower.includes('suzana') || childNameLower.includes('karina') || childNameLower.includes('pabline');
      
      if (!isUnmonitored) {
        // Group vitals by time
        const parseReadings = (str: string) => {
          if (!str || str === '-') return [];
          return str.split(' | ').map(p => {
            const timeMatch = p.match(/^\[(\d{2}:\d{2}h)\]\s*(.*)$/);
            return {
              time: timeMatch ? timeMatch[1] : null,
              value: timeMatch ? timeMatch[2] : p
            };
          });
        };

        const spo2Readings = parseReadings(child.spo2);
        const fcReadings = parseReadings(child.fc);
        const taxReadings = parseReadings(child.tax);

        // Collect all unique times
        const allTimes = Array.from(new Set([
          ...spo2Readings.map(r => r.time),
          ...fcReadings.map(r => r.time),
          ...taxReadings.map(r => r.time)
        ])).filter(Boolean).sort() as string[];

        if (allTimes.length > 0) {
          allTimes.forEach(time => {
            text += `[${time}]\n`;
            const s = spo2Readings.find(r => r.time === time);
            const f = fcReadings.find(r => r.time === time);
            const t = taxReadings.find(r => r.time === time);
            
            if (s) text += `_SpO²:_ ${formatVital(s.value, '%')}\n`;
            if (f) text += `_FC:_ ${formatVital(f.value, 'BPM')}\n`;
            if (t) text += `_TAX:_ ${formatVital(t.value, '°C')}\n`;
            text += `\n`;
          });
          
          // Also show any readings that didn't have a time prefix (if any)
          const untimedS = spo2Readings.filter(r => !r.time).map(r => r.value).join(' | ');
          const untimedF = fcReadings.filter(r => !r.time).map(r => r.value).join(' | ');
          const untimedT = taxReadings.filter(r => !r.time).map(r => r.value).join(' | ');
          
          if (untimedS) text += `_SpO² (Manual):_ ${formatVital(untimedS, '%')}\n`;
          if (untimedF) text += `_FC (Manual):_ ${formatVital(untimedF, 'BPM')}\n`;
          if (untimedT) text += `_TAX (Manual):_ ${formatVital(untimedT, '°C')}\n`;
          if (untimedS || untimedF || untimedT) text += `\n`;
        } else {
          // Fallback to simple list if no times are found
          text += `_SpO²:_ ${formatVital(child.spo2, '%')}\n`;
          text += `_FC:_ ${formatVital(child.fc, 'BPM')}\n`;
          text += `_TAX:_ ${formatVital(child.tax, '°C')}\n\n`;
        }
      }
      
      if (child.obs) text += `*Informações Importantes:* ${child.obs}\n`;
      text += `\n`;
    });

    if (report.generalInfo) {
      text += `*Informações gerais:*\n${report.generalInfo}\n\n`;
    }

    text += `*Responsáveis:* ${report.staff}`;
    return text;
  };

  const generateShiftReportObject = (targetRoom: string, defaultDate: string, staff: string = '', generalInfo: string = '', authorUid: string = 'sistema_automatico'): ShiftReport => {
    const roomChildren = profiles.filter(p => targetRoom === 'Internação Temporária' ? p.id === internedChildId : p.room === targetRoom).sort((a,b) => a.name.localeCompare(b.name));

    const shiftStart = new Date(`${defaultDate}T07:05:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000); 

    const childrenData = roomChildren.map(child => {
      let lastData: ChildShiftData | undefined;
      for (let i = 0; i < shiftReports.length; i++) {
        if (shiftReports[i].room === targetRoom && shiftReports[i].date < defaultDate) {
          const found = shiftReports[i].childrenData?.find(cd => cd.childName === child.name);
          if (found) {
            lastData = found;
            break;
          }
        }
      }

      const activitiesSummary = getChildActivitiesSummary(child.name, defaultDate);
      const generalStateContent = getGeneralStateForChild(child.name, defaultDate, activitiesSummary.summaryText, activitiesSummary.rotinaItems);

      const shiftVitals = vitalSigns
           .filter(v => v.childId === child.id)
           .filter(v => {
              const t = new Date(v.timestamp).getTime();
              return t >= shiftStart && t < shiftEnd;
           })
           .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const vitalsSummary = getVitalSignsSummary(shiftVitals, targetRoom === 'Internação Temporária');

      const { diuresis, evacuation } = getEvacuationAndDiuresisFromActivities(child.name, defaultDate, lastData);

      return {
        childId: child.id,
        childName: child.name,
        generalState: generalStateContent,
        spo2: vitalsSummary.spo2,
        fc: vitalsSummary.fc,
        tax: vitalsSummary.tax,
        diuresis: diuresis,
        evacuation: evacuation,
        feeding: 'Ok',
        water: 'Ok',
        obs: ''
      };
    });

    const dateSlug = (defaultDate || '').replace(/[^a-z0-9]/gi, '-');
    const roomSlug = (targetRoom || '').toLowerCase().replace(/[^a-z0-9]/gi, '-');
    const houseSlug = 'solar-meimei';

    return {
      id: `shift_${houseSlug}_${roomSlug}_${dateSlug}`,
      date: defaultDate,
      room: targetRoom,
      house: 'Solar Meimei',
      staff: staff,
      generalInfo: generalInfo,
      importantInfo: '',
      childrenData,
      createdAt: serverTimestamp() as any,
      authorUid: authorUid
    };
  };

  const generateVirtualShiftReport = () => {
    const targetRoom = autoReportParams.room || myActiveRoom || ROOM_OPTIONS[0];
    const defaultDate = autoReportParams.date || getShiftDateString();
    
    const report = generateShiftReportObject(targetRoom, defaultDate, user?.displayName || 'Sistema', autoReportParams.generalInfo);
    return formatShiftReportForWhatsApp(report);
  };

  const handleAcknowledgeMedication = async (notif: AppNotification) => {
    const isLate = isMedicationLate(notif);
    const justification = medicationJustifications[notif.id];

    if (isLate && (!justification || justification.trim() === '')) {
      alert("Por favor, preencha a justificativa para o atraso.");
      return;
    }

    // Mark as read
    const userFirstName = user?.displayName ? user.displayName.trim().split(' ')[0] : (user?.email ? user.email.split('@')[0] : 'Desconhecido');
    
    const isAlreadyRead = notif.readBy?.some(r => 
      (user?.uid && r.uid === user.uid) || r.name === userFirstName
    );

    const readInfo = {
      uid: user?.uid || 'anonymous',
      name: userFirstName,
      timestamp: new Date().toISOString()
    };

    const updatedNotif = { 
      ...notif, 
      isRead: true,
      readBy: isAlreadyRead ? (notif.readBy || []) : [...(notif.readBy || []), readInfo]
    };

    if (user) {
      try {
        await setDoc(doc(db, 'notifications', notif.id), removeUndefined(updatedNotif));
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `notifications/${notif.id}`);
      }
    } else {
      setNotifications(notifications.map(n => n.id === notif.id ? updatedNotif : n));
    }

    let finalDescription = `Check-out realizado: ${notif.description}`;
    if (isLate) {
      finalDescription += `\n⚠️ Atraso (>15min). Justificativa: ${justification}`;
    }
    
    // Create an activity log
    const newActivity: any = {
      id: Math.random().toString(36).substr(2, 9),
      childName: notif.title,
      type: 'medication',
      description: finalDescription,
      timestamp: new Date().toISOString(),
      status: 'completed',
      authorUid: user?.uid || 'unknown',
      authorName: user?.displayName || user?.email || 'Desconhecido'
    };
    
    if (user) {
      try {
        await setDoc(doc(db, 'activities', newActivity.id), newActivity);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `activities/${newActivity.id}`);
      }
    } else {
      setActivities([newActivity as ChildActivity, ...activities]);
    }
    
    setActiveMedicationReminders(prev => prev.filter(n => n.id !== notif.id));
    setMedicationJustifications(prev => {
      const newState = { ...prev };
      delete newState[notif.id];
      return newState;
    });
  };

  const handleSaveNotification = async () => {
    if (!notificationForm.title || (!notificationForm.date && !notificationForm.startDate)) return;

    const newNotification: any = {
      ...notificationForm,
      date: notificationForm.date || notificationForm.startDate || '',
      startDate: notificationForm.startDate || notificationForm.date || '',
      endDate: notificationForm.endDate || notificationForm.startDate || notificationForm.date || '',
      id: Math.random().toString(36).substr(2, 9),
      isRead: false,
      authorUid: user?.uid || 'unknown',
      createdAt: serverTimestamp()
    };
    
    if (user) {
      try {
        await setDoc(doc(db, 'notifications', newNotification.id), removeUndefined(newNotification));
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `notifications/${newNotification.id}`);
      }
    } else {
      setNotifications([newNotification as AppNotification, ...notifications]);
    }
    
    setIsNotificationModalOpen(false);
    setNotificationForm({ title: '', description: '', date: '', startDate: '', endDate: '', time: '', type: 'other', imageUrl: '' });
  };

  const handleAISearch = async () => {
    if (!searchQuery.trim()) return;

    const currentQuery = searchQuery;
    const newUserMessage = { role: 'user' as const, content: currentQuery };
    setSearchMessages(prev => [...prev, newUserMessage]);
    setSearchQuery('');
    setIsSearching(true);

    try {
      // 1. Prepare Data Context
      const context = {
        profiles: profiles.map(p => ({
          name: p.name,
          room: p.room || 'Não informado',
          birthDate: p.birthDate,
          weight: p.weight || 'Não informado',
          supportDevices: p.supportDevices?.join(', ') || 'Sem dispositivos',
          diets: `Líquida: ${p.liquidDiet}, Sólida: ${p.solidDiet}`,
          recurringMedications: p.recurringMedications?.map(m => `${m.name} (${m.times?.join(', ')})`).join('; ') || 'Nenhuma',
          specialMedications: p.specialMedications?.map(m => `${m.name} (${m.times?.join(', ')})`).join('; ') || 'Nenhuma',
          sosMedications: p.sosMedications || 'Nenhuma',
          temporaryMedications: (Array.isArray(p.temporaryMedications) ? p.temporaryMedications.map(tm => `${tm.description}${tm.times && tm.times.length > 0 ? ` (${tm.times.join(', ')})` : ''} (até ${tm.endDate} ${tm.endTime})`).join('; ') : 'Nenhuma'),
          preferences: p.preferences || 'Nenhuma'
        })),
        legacyReports: legacyReports.map(lr => `Data: ${lr.date} - Análise: ${lr.aiAnalysis}`).join(' | '),
        recentActivities: activities.slice(0, 100).map(a => ({
          child: a.childName,
          desc: a.description,
          date: a.timestamp,
          type: a.type
        })),
        recentReports: shiftReports.slice(0, 10).map(r => ({
          room: r.room,
          staff: r.staff,
          date: r.date,
          children: r.childrenData.map(c => `${c.childName}: ${c.generalState}`).join('; ')
        }))
      };

      if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY não configurado.");
      }
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `
        Você é o Assistente Virtual do Instituto do Carinho.
        Sua tarefa é responder perguntas dos funcionários usando os dados do banco de dados fornecidos abaixo.
        
        Sempre responda em Português do Brasil.
        
        DADOS DO BANCO DE DADOS:
        ${JSON.stringify(context)}
        
        PERGUNTA DO USUÁRIO:
        ${currentQuery}
        
        INSTRUÇÕES:
        - Responda de forma clara, profissional e carinhosa.
        - Se não encontrar a informação nos dados fornecidos, diga que não encontrou nos registros recentes.
        - Mantenha o foco em informações sobre as crianças, medicamentos, atividades e relatórios.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        config: {
          systemInstruction: "Você é um assistente especializado em gestão de plantão para um instituto de cuidados de crianças especiais. Seja empático, preciso e útil."
        },
        contents: prompt,
      });

      const aiResponse = response.text || "Desculpe, não consegui processar sua pergunta.";
      setSearchMessages(prev => [...prev, { role: 'ai', content: aiResponse }]);
    } catch (error) {
      console.error("AI Search Error:", error);
      setSearchMessages(prev => [...prev, { role: 'ai', content: "Houve um erro de permissão (403). Verifique se você configurou sua GEMINI_API_KEY corretamente na aba Settings > Secrets do AI Studio." }]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleNotificationImageUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressedDataUrl = await compressImage(file);
      setNotificationForm(prev => ({ ...prev, imageUrl: compressedDataUrl }));
    } catch (error) {
      console.error("Erro ao processar imagem:", error);
    }
  };

  const handleAddChildToShift = (child: ChildProfile) => {
    // Search for the most recent data for this child in previous reports
    let lastData: ChildShiftData | undefined;
    
    // shiftReports is already sorted by newest first
    for (const report of shiftReports) {
      const found = report.childrenData.find(c => c.childId === child.id);
      if (found) {
        lastData = found;
        break;
      }
    }

    // Find activities for this child on the report date
    const reportDate = currentShiftReport.date || getShiftDateString();
    const activitiesSummary = getChildActivitiesSummary(child.name, reportDate);
    const { diuresis, evacuation } = getEvacuationAndDiuresisFromActivities(child.name, reportDate, lastData);
    
    const generalStateContent = getGeneralStateForChild(child.name, reportDate, activitiesSummary.summaryText, activitiesSummary.rotinaItems);

    const shiftStart = new Date(`${reportDate}T07:05:00`).getTime();
    const shiftEnd = shiftStart + (24 * 60 * 60 * 1000);

    const shiftVitals = vitalSigns
      .filter(v => v.childId === child.id)
      .filter(v => {
         const t = new Date(v.timestamp).getTime();
         return t >= shiftStart && t < shiftEnd;
      });

    const vitalsSummary = getVitalSignsSummary(shiftVitals, currentShiftReport.room === 'Internação Temporária');

    const newData: ChildShiftData = lastData ? {
      childId: child.id,
      childName: child.name,
      generalState: generalStateContent,
      spo2: vitalsSummary.spo2,
      fc: vitalsSummary.fc,
      tax: vitalsSummary.tax,
      diuresis: diuresis,
      evacuation: evacuation,
      feeding: lastData.feeding,
      water: lastData.water,
      obs: activitiesSummary.summaryText
    } : {
      childId: child.id,
      childName: child.name,
      generalState: generalStateContent,
      spo2: vitalsSummary.spo2,
      fc: vitalsSummary.fc,
      tax: vitalsSummary.tax,
      diuresis: diuresis,
      evacuation: evacuation,
      feeding: 'Ok',
      water: 'Ok',
      obs: activitiesSummary.summaryText
    };

    setCurrentShiftReport({
      ...currentShiftReport,
      childrenData: [...(currentShiftReport.childrenData || []), newData]
    });
  };

  const updateChildShiftData = (index: number, field: keyof ChildShiftData, value: string) => {
    const newChildrenData = [...(currentShiftReport.childrenData || [])];
    newChildrenData[index] = { ...newChildrenData[index], [field]: value };
    setCurrentShiftReport({ ...currentShiftReport, childrenData: newChildrenData });
  };

  const removeChildFromShift = (index: number) => {
    const newChildrenData = [...(currentShiftReport.childrenData || [])];
    newChildrenData.splice(index, 1);
    setCurrentShiftReport({ ...currentShiftReport, childrenData: newChildrenData });
  };

  const copyToClipboard = (text: string, message?: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setToast({ message: message || 'Relatório copiado para a área de transferência!', show: true });
      setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
    }).catch(err => {
      console.error('Falha ao copiar:', err);
    });
  };

  const downloadICS = (notif: AppNotification) => {
    const [year, month, day] = notif.date.split('-');
    const [hours, minutes] = notif.time.split(':');
    
    // Create start time in local time format for ICS (YYYYMMDDTHHMMSS)
    const start = `${year}${month}${day}T${hours}${minutes}00`;
    
    // End time 15 mins later
    const endDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes) + 15);
    const endYear = endDate.getFullYear();
    const endMonth = String(endDate.getMonth() + 1).padStart(2, '0');
    const endDay = String(endDate.getDate()).padStart(2, '0');
    const endHours = String(endDate.getHours()).padStart(2, '0');
    const endMinutes = String(endDate.getMinutes()).padStart(2, '0');
    const end = `${endYear}${endMonth}${endDay}T${endHours}${endMinutes}00`;

    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Shift Report App//PT
BEGIN:VEVENT
DTSTART:${start}
DTEND:${end}
SUMMARY:Medicação: ${notif.title}
DESCRIPTION:${notif.description}
BEGIN:VALARM
TRIGGER:-PT5M
ACTION:DISPLAY
DESCRIPTION:Lembrete de Medicação
END:VALARM
END:VEVENT
END:VCALENDAR`;

    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.setAttribute('download', `medicacao_${notif.title.replace(/\s+/g, '_')}.ics`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const visibleNotifications = notifications.filter(n => {
    if (n.isDeleted) return false;
    
    // Handle medication checkout notifications separately (they have their own popup)
    if (n.type === 'medication_checkout') return false;
    
    const triggerDate = n.startDate || n.date;
    if (triggerDate && triggerDate > getLocalDateString()) {
      return false; // Don't show notifications from the future
    }
    
    return true;
  });

  const currentNotifications = visibleNotifications.filter(n => {
    const compareDate = n.endDate || n.date;
    return !compareDate || compareDate >= getLocalDateString();
  });
  const archivedNotifications = visibleNotifications.filter(n => {
    const compareDate = n.endDate || n.date;
    return compareDate && 
      compareDate < getLocalDateString() && 
      !n.title.includes('48h antes');
  });
  const displayedNotifications = notificationTab === 'current' ? currentNotifications : archivedNotifications;

  const unreadCount = currentNotifications.filter(n => !n.isRead).length;

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 font-sans">
        <Heart className="w-12 h-12 text-rose-500 fill-rose-500 animate-pulse mb-6" />
        <div className="h-2 w-32 bg-slate-200 rounded-full overflow-hidden">
          <div className="h-full bg-rose-500 animate-[pulse_1.5s_ease-in-out_infinite]" style={{ width: '60%' }}></div>
        </div>
        <p className="mt-4 text-slate-500 font-bold text-sm">Carregando Diário Institucional...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 pb-20 md:pb-0">
      {user ? (
        <>
          {!myActiveRoom && !pendingInternacao ? (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="w-full max-w-sm space-y-6">
            <div className="text-center space-y-1">
              <div className="inline-flex p-2 rounded-full bg-white shadow-sm mb-1">
                <Heart className="w-5 h-5 text-sky-500" />
              </div>
              <h2 className="text-xl font-black text-slate-800 tracking-tight">Selecione seu Quarto</h2>
              <p className="text-xs text-slate-500 font-medium px-4">Para qual enfermaria você está escalado neste plantão?</p>
            </div>
            
            <div className="space-y-4">
              {/* Standard Rooms */}
              <div className="space-y-2">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-4">Enfermarias Fixas</h3>
                <div className="grid grid-cols-1 gap-2.5">
                  {[
                    { name: 'Tamanduá Bandeira', color: 'bg-amber-500' },
                    { name: 'Arara Vermelha', color: 'bg-rose-500' },
                    { name: 'Solar Meimei', color: 'bg-sky-500' }
                  ].map(room => {
                    const childrenInRoom = profiles
                      .filter(p => p.isActive !== false && p.room === room.name)
                      .map(p => p.name.split(' ')[0])
                      .join(', ');

                    return (
                    <button
                      key={room.name}
                      onClick={() => handleSelectRoom(room.name)}
                      className={`w-full group relative overflow-hidden rounded-[2rem] p-1.5 transition-all duration-300 hover:scale-[1.02] ${room.color} shadow hover:shadow-md text-left flex items-center justify-between min-h-[3.5rem]`}
                    >
                      {/* Content */}
                      <div className="relative z-10 flex flex-col justify-center min-w-0 pl-4 py-1.5">
                        <h4 className="text-[14px] font-bold text-white truncate drop-shadow-sm tracking-wide leading-tight">{room.name}</h4>
                        {childrenInRoom ? (
                          <p className="text-[11px] font-semibold text-white/80 truncate mt-0.5 pr-2 leading-tight">
                            {childrenInRoom}
                          </p>
                        ) : (
                          <p className="text-[11px] font-semibold text-white/60 truncate mt-0.5 pr-2 leading-tight">
                            Vazia
                          </p>
                        )}
                      </div>
                      
                      {/* Pill toggle "thumb" */}
                      <div className="relative z-10 shrink-0 h-10 w-14 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center shadow-[inset_0_2px_4px_rgba(255,255,255,0.2)] border border-white/10 group-hover:bg-white/30 transition-colors mr-1">
                        <ChevronRight className="w-5 h-5 text-white drop-shadow-md" />
                      </div>
                    </button>
                  )})}
                </div>
              </div>

              {/* Temporary Room */}
              <div className="space-y-2 pt-3 border-t border-slate-200/60">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-4">Enfermaria Isolada</h3>
                <button
                  onClick={() => handleSelectRoom('Internação Temporária')}
                  className="w-full group relative overflow-hidden rounded-full p-1.5 transition-all duration-300 hover:scale-[1.02] bg-emerald-500 shadow hover:shadow-md text-left flex items-center justify-between h-12"
                >
                  {/* Content */}
                  <div className="relative z-10 flex items-center gap-3 min-w-0 pl-3">
                    <div className="min-w-0">
                      <h4 className="text-[13px] font-bold text-white truncate drop-shadow-sm tracking-wide">Internação Temporária</h4>
                    </div>
                  </div>
                  
                  <div className="relative z-10 shrink-0 h-9 w-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center shadow-[inset_0_2px_4px_rgba(255,255,255,0.2)] border border-white/10 group-hover:bg-white/30 transition-colors">
                    <ChevronRight className="w-5 h-5 text-white drop-shadow-md" />
                  </div>
                </button>
              </div>
              
              {/* Admin/Fake Room */}
              <div className="pt-4 mt-4 text-sm">
                <button
                  onClick={() => {
                    setRoomToAccess(ADMIN_ROOM);
                    setIsPasswordModalOpen(true);
                  }}
                  className="w-full p-3 rounded-2xl border border-dashed border-slate-300 hover:border-indigo-400 hover:bg-white bg-slate-50/50 transition-all font-bold text-slate-500 hover:text-indigo-600 flex items-center justify-between group shadow-sm hover:shadow-md"
                >
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-slate-200/50 group-hover:bg-indigo-100 transition-colors text-slate-400 group-hover:text-indigo-500">
                      <Stethoscope className="w-4 h-4" />
                    </div>
                    <span>{ADMIN_ROOM}</span>
                  </div>
                  <span className="text-[10px] bg-white group-hover:bg-indigo-50 text-slate-400 group-hover:text-indigo-600 px-2 py-1 rounded-md uppercase tracking-wider font-black border border-slate-200 group-hover:border-indigo-100 transition-all shadow-sm">
                    Restrito
                  </span>
                </button>
              </div>
            </div>
            
            <div className="pt-6 flex items-center justify-center">
              <button
                onClick={() => auth.signOut()}
                className="text-xs font-bold text-slate-400 hover:text-rose-500 transition-colors uppercase tracking-widest flex items-center gap-2 bg-white px-5 py-2.5 rounded-full shadow-sm hover:shadow-md"
              >
                <AlertCircle className="w-3.5 h-3.5" /> Sair da conta
              </button>
            </div>
          </div>
        </div>
          ) : pendingInternacao ? (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
              <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full space-y-6">
                <div className="text-center space-y-2">
                  <h2 className="text-2xl font-bold text-slate-800">Selecione a Criança</h2>
                  <p className="text-slate-500">Quem está na Internação Temporária hoje?</p>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Criança Internada</label>
                    <select 
                      value={internedChildId}
                      onChange={(e) => setInternedChildId(e.target.value)}
                      className="w-full p-4 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-sky-200"
                    >
                      <option value="">{profiles.length === 0 ? 'Carregando crianças...' : 'Selecione uma criança...'}</option>
                      {profiles.filter(p => p.isActive !== false).sort((a,b) => a.name.localeCompare(b.name)).map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div className="flex gap-2 pt-2">
                    <button 
                      onClick={() => {
                        setPendingInternacao(false);
                        setInternedChildId('');
                      }}
                      className="px-4 py-3 bg-slate-100 text-slate-500 rounded-xl font-bold text-sm hover:bg-slate-200 transition-all"
                    >
                      Voltar
                    </button>
                    <button 
                      onClick={() => {
                        if (!internedChildId) {
                           alert('Selecione uma criança primeiro.');
                           return;
                        }
                        handleSelectRoom('Internação Temporária', internedChildId);
                      }}
                      className="flex-1 py-3 bg-sky-500 text-white rounded-xl font-bold text-sm hover:bg-sky-600 transition-all disabled:opacity-50"
                      disabled={!internedChildId}
                    >
                      Continuar
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
          {/* Header */}
          <motion.header className={`bg-white/95 backdrop-blur-md border-b border-slate-200 sticky top-0 z-40 transition-shadow duration-500 ${compact ? 'shadow-md' : ''}`}>
        <motion.div 
          layout
          style={{ 
            paddingTop: isMainTab ? headerPadding : '0.75rem', 
            paddingBottom: isMainTab ? headerPadding : '0.75rem' 
          }}
          className={`max-w-5xl mx-auto px-4 w-full flex flex-row items-center gap-2 relative ${isCompactHeader ? 'justify-center md:justify-between' : 'justify-between'}`}
        >
          <motion.div 
            layout
            className="flex flex-row items-center gap-2 md:gap-4 logo-container"
          >
            <div className="flex flex-col items-center">
              <motion.button 
                style={{ 
                  scale: isMainTab ? logoScale : 0.8, 
                  padding: isMainTab ? buttonPadding : '0rem' 
                }}
                onClick={() => window.location.reload()}
                className="bg-slate-50 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center -space-x-5 hover:bg-slate-100 transition-colors cursor-pointer group origin-center md:origin-left"
                title="Atualizar página"
              >
                <Heart className="w-10 h-10 text-sky-500 fill-sky-500 rotate-45 z-10 relative translate-y-1 group-hover:scale-105 transition-transform" />
                <Heart className="w-10 h-10 text-rose-500 fill-rose-500 relative group-hover:scale-105 transition-transform" />
              </motion.button>
              <motion.span 
                style={{ 
                  opacity: isMainTab ? hideOnScroll : 0, 
                  scale: isMainTab ? hideOnScroll : 0,
                  height: isMainTab ? betaHeight : '0px',
                  marginTop: isMainTab ? betaMargin : '0px',
                  overflow: 'hidden'
                }}
                className="bg-sky-100 text-sky-600 text-[9px] leading-tight font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wider border border-sky-200 origin-top flex items-center justify-center"
              >
                Beta
              </motion.span>
            </div>
            <div className="flex flex-col items-center md:items-start overflow-hidden">
              <div className="flex items-center gap-2 md:gap-3">
                <motion.h1 
                  style={{ fontSize: isMainTab ? titleSize : '1.25rem' }}
                  className="font-black text-slate-900 tracking-tighter"
                >
                  Instituto <span className="text-sky-500">do</span> Carinho
                </motion.h1>
                {user && (
                  <motion.button 
                    style={{ 
                      scale: isMainTab ? profileScale : 0.8, 
                      transformOrigin: "left center"
                    }}
                    onClick={() => setIsLogoutModalOpen(true)}
                    className="md:hidden w-10 h-10 ml-1 shrink-0 bg-white rounded-full shadow-md flex items-center justify-center border border-slate-100 overflow-hidden z-20 hover:scale-105 active:scale-95 transition-all group"
                  >
                    <div className="absolute inset-0 bg-indigo-500 opacity-0 group-hover:opacity-10 transition-opacity"></div>
                    <img 
                      src={user.photoURL || `https://ui-avatars.com/api/?name=${user.email}`} 
                      alt="User" 
                      className="w-full h-full object-cover" 
                      referrerPolicy="no-referrer" 
                    />
                  </motion.button>
                )}
              </div>
              <motion.div
                style={{ 
                  opacity: isMainTab ? hideOnScroll : 0, 
                  height: isMainTab ? subtitleHeight : '0rem' 
                }}
                className="flex flex-col overflow-hidden"
              >
                <p className="text-[10px] md:text-xs text-slate-400 font-bold uppercase tracking-[0.2em] whitespace-nowrap">
                  Assistente de Organização e Relatórios
                </p>
                {myActiveRoom && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${myActiveRoom === ADMIN_ROOM ? 'bg-indigo-500' : 'bg-emerald-500'}`}></span>
                    <span className={`text-[9px] font-black uppercase tracking-tighter ${myActiveRoom === ADMIN_ROOM ? 'text-indigo-600' : 'text-emerald-600'}`}>
                      {myActiveRoom}
                    </span>
                  </div>
                )}
              </motion.div>
            </div>
          </motion.div>
          
          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-4">
            <nav className="flex gap-1 bg-slate-100 p-1 rounded-2xl">
              {[
                { id: 'input', label: 'Registros', icon: PlusCircle },
                { id: 'reports', label: 'Relatórios', icon: FileText },
                { id: 'search', label: 'Pesquisa AI', icon: Sparkles },
                { id: 'profiles', label: 'Perfis', icon: Users },
                { id: 'shift-report', label: 'Plantão', icon: ClipboardList },
                { id: 'notifications', label: 'Lembretes', icon: Bell, badge: unreadCount }
              ].map((tab) => (
                <button 
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as Tab)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all relative ${
                    activeTab === tab.id ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500 hover:bg-slate-200/50'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                  {tab.badge ? (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white text-[10px] flex items-center justify-center rounded-full border-2 border-white">
                      {tab.badge}
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>
            {user ? (
              <div className="flex items-center gap-3 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200">
                <img src={user.photoURL || `https://ui-avatars.com/api/?name=${user.email}`} alt="User" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
                <button onClick={() => setIsLogoutModalOpen(true)} className="text-xs font-bold text-slate-500 hover:text-rose-500">Sair</button>
              </div>
            ) : (
              <button 
                onClick={handleLogin} 
                disabled={isLoggingIn}
                className="bg-sky-500 text-white px-4 py-2 rounded-xl font-bold text-sm hover:bg-sky-600 transition-all disabled:opacity-50"
              >
                {isLoggingIn ? 'Entrando...' : 'Entrar'}
              </button>
            )}
          </div>
        </motion.div>
      </motion.header>

      {/* Mobile Nav */}
      <AnimatePresence>
        {!isKeyboardVisible && (
          <motion.nav 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="md:hidden fixed bottom-1.5 left-1.5 right-1.5 bg-white/90 backdrop-blur-md border border-slate-200 px-4 py-2 flex flex-col gap-2 rounded-3xl shadow-lg shadow-slate-200/50 z-40"
          >

        {myActiveRoom && (
          <div className="flex items-center justify-center gap-1.5 pb-1 border-b border-slate-100/50">
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${myActiveRoom === ADMIN_ROOM ? 'bg-indigo-500' : 'bg-emerald-500'}`}></span>
            <span className={`text-[9px] font-black uppercase tracking-tighter ${myActiveRoom === ADMIN_ROOM ? 'text-indigo-600' : 'text-emerald-600'}`}>
              {myActiveRoom}
            </span>
          </div>
        )}
        <div className="flex justify-between items-center">
          {[
            { id: 'input', icon: PlusCircle },
            { id: 'reports', icon: FileText },
            { id: 'search', icon: Sparkles },
            { id: 'profiles', icon: Users },
            { id: 'shift-report', icon: ClipboardList },
            { id: 'notifications', icon: Bell, badge: unreadCount }
          ].map((tab) => (
            <button 
              key={tab.id}
              onClick={() => setActiveTab(tab.id as Tab)}
              className={`p-2 rounded-xl transition-all relative ${
                activeTab === tab.id ? 'bg-sky-50 text-sky-600 shadow-inner' : 'text-slate-400'
              }`}
            >
              <tab.icon className="w-6 h-6" />
              {tab.badge ? (
                <span className="absolute top-1 right-1 w-4 h-4 bg-rose-500 text-white text-[10px] flex items-center justify-center rounded-full border-2 border-white">
                  {tab.badge}
                </span>
              ) : null}
            </button>
          ))}
          </div>
        </motion.nav>
      )}
      </AnimatePresence>

      {/* Desktop Footer Status Bar */}
      {myActiveRoom && (
        <div className="hidden md:flex fixed bottom-0 left-0 right-0 bg-white/60 backdrop-blur-xs border-t border-slate-100 px-6 py-1 justify-end z-30">
          <div className="flex items-center gap-2 px-3 py-0.5 bg-white/80 rounded-full border border-slate-200 shadow-sm">
            <span className={`w-1.2 h-1.2 rounded-full animate-pulse ${myActiveRoom === ADMIN_ROOM ? 'bg-indigo-500' : 'bg-emerald-500'}`}></span>
            <span className={`text-[10px] font-black uppercase tracking-tighter ${myActiveRoom === ADMIN_ROOM ? 'text-indigo-600' : 'text-emerald-600'}`}>
              {myActiveRoom}
            </span>
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 pt-2 pb-24 md:pb-12">
        <AnimatePresence mode="wait">
          {activeTab === 'input' && (
            <motion.div
              key="input-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-4"
            >
              {/* Notification Master Switch - Only for Posto de Enfermagem */}
              {myActiveRoom === ADMIN_ROOM && (
                <div className="space-y-4">
                  <section className="bg-gradient-to-r from-indigo-500 to-purple-600 p-3 rounded-[2rem] shadow-sm border border-indigo-400 text-white overflow-hidden relative group">
                    <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                      <BellRing className="w-12 h-12 -rotate-12" />
                    </div>
                    <div className="relative z-10 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                        <div className={`p-1.5 sm:p-2 rounded-xl shrink-0 ${medicationNotificationsEnabled ? 'bg-white/20 shadow-inner' : 'bg-white/10 opacity-70'}`}>
                          {medicationNotificationsEnabled ? <BellRing className="w-4 h-4 sm:w-5 sm:h-5 text-white" /> : <Bell className="w-4 h-4 sm:w-5 sm:h-5 text-white" />}
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-black text-sm sm:text-base leading-tight uppercase tracking-tighter truncate">Alertas de Medicação</h3>
                          <p className="text-white/80 text-[9px] sm:text-[10px] font-medium truncate">Controle para todos os quartos</p>
                        </div>
                      </div>
                      
                      <button 
                        onClick={toggleMedicationNotifications}
                        className={`relative w-10 sm:w-12 h-6 sm:h-7 rounded-full transition-all duration-300 flex items-center p-0.5 cursor-pointer shrink-0 ${medicationNotificationsEnabled ? 'bg-emerald-400 border border-emerald-300' : 'bg-slate-300/30 border border-white/20'}`}
                      >
                        <motion.div 
                          animate={{ x: medicationNotificationsEnabled ? (window.innerWidth < 640 ? '1rem' : '1.25rem') : '0rem' }}
                          className={`w-4.5 h-4.5 sm:w-5 sm:h-5 rounded-full shadow-lg ${medicationNotificationsEnabled ? 'bg-white' : 'bg-slate-200'}`}
                        />
                      </button>
                    </div>
                  </section>
                </div>
              )}

              <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 space-y-4">
                <div className="flex items-center gap-2 text-sky-600 font-semibold mb-2">
                  <ClipboardList className="w-5 h-5" />
                  <span>Descrição do Evento (Atalho para Relatório)</span>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Criança</label>
                    <select
                      value={selectedChildForEvent}
                      onChange={(e) => setSelectedChildForEvent(e.target.value)}
                      className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 text-slate-700"
                    >
                      <option value="" disabled>{profiles.length === 0 ? 'Carregando crianças...' : 'Selecione a criança...'}</option>
                      {profiles
                        .filter(p => !myActiveRoom || myActiveRoom === ADMIN_ROOM || (myActiveRoom === 'Internação Temporária' ? p.id === internedChildId : p.room === myActiveRoom))
                        .map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Observação</label>
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={'Para alterar o "estado geral" comece o relato com "estado geral" passou o dia...\nPara alterar a Evacuação, escreva: "Evacuação presente ou ausente x dias"'}
                      className="w-full h-32 p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 resize-none text-slate-700 placeholder:text-slate-400 transition-all"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:items-end">
                  <button
                    onClick={handleSaveRawEvent}
                    disabled={isProcessing || !inputText.trim() || !selectedChildForEvent}
                    className={`flex items-center justify-center gap-2 px-8 py-3 rounded-2xl font-bold transition-all w-full sm:w-auto ${
                      isProcessing || !inputText.trim() || !selectedChildForEvent
                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                        : 'bg-sky-500 text-white hover:bg-sky-600 shadow-lg shadow-sky-100 active:scale-95'
                    }`}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Adicionando...
                      </>
                    ) : (
                      <>
                        <Send className="w-5 h-5" />
                        Adicionar ao relatório
                      </>
                    )}
                  </button>
                  {myActiveRoom === ADMIN_ROOM && (
                    <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                      <button 
                        onClick={() => setIsPrescriptionModalOpen(true)}
                        className="flex items-center justify-center gap-2 px-6 py-3 bg-indigo-50 text-indigo-600 rounded-2xl font-bold hover:bg-indigo-100 transition-all active:scale-95 border border-indigo-100 w-full sm:w-auto text-sm"
                      >
                        <FileUp className="w-5 h-5" />
                        Upload de Prescrição
                      </button>
                      <button 
                        onClick={() => setIsLegacyReportModalOpen(true)}
                        className="flex items-center justify-center gap-2 px-6 py-3 bg-purple-50 text-purple-600 rounded-2xl font-bold hover:bg-purple-100 transition-all active:scale-95 border border-purple-100 w-full sm:w-auto text-sm"
                      >
                        <History className="w-5 h-5" />
                        Histórico Legado
                      </button>
                    </div>
                  )}
                  <button 
                    onClick={() => {
                      setVitalSignsForm(prev => ({ ...prev, childId: selectedChildForEvent }));
                      setIsVitalSignsModalOpen(true);
                    }}
                    className="flex items-center justify-center gap-2 px-6 py-3 bg-rose-50 text-rose-600 rounded-2xl font-bold hover:bg-rose-100 transition-all active:scale-95 border border-rose-100 w-full sm:w-auto"
                  >
                    <Activity className="w-5 h-5" />
                    Sinais Vitais
                  </button>
                </div>
              </section>

              {/* Próximas Medicações Section */}
              <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 space-y-4">
                <button 
                  onClick={() => setIsMedsOpen(!isMedsOpen)}
                  className="w-full flex items-center justify-between group"
                >
                  <div className="flex items-center gap-2 text-amber-600 font-semibold">
                    <Pill className="w-5 h-5" />
                    <span>Próximas medicações</span>
                    {selectedRoomForMeds && (
                      <span className="text-[10px] bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full border border-amber-100 ml-1">
                        {selectedRoomForMeds}
                      </span>
                    )}
                  </div>
                  <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform ${isMedsOpen ? 'rotate-90' : ''}`} />
                </button>
                
                {isMedsOpen && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="space-y-4 overflow-hidden"
                  >
                    {selectedRoomForMeds && (
                      <div className="space-y-6">
                    {/* Scheduled Meds */}
                    <div className="space-y-3">
                      <h4 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-sky-500" /> Programadas (Próximas medicações)
                      </h4>
                      {getRoomMedications(selectedRoomForMeds).scheduled.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-2">
                          {getRoomMedications(selectedRoomForMeds).scheduled.map((med, idx) => (
                            <div key={idx} className={`${med.isSpecial ? 'bg-purple-50 border-purple-200' : med.isDiet ? 'bg-emerald-50 border-emerald-100' : med.isTemporary ? 'bg-orange-50 border-orange-100' : 'bg-amber-50 border-amber-100'} p-3 sm:p-4 rounded-2xl border flex items-center justify-between gap-3`}>
                              <div className="min-w-0">
                                <p className="font-bold text-slate-800 truncate text-sm sm:text-base">{med.childName}</p>
                                <div className="text-xs sm:text-sm text-slate-600 flex flex-wrap gap-1 items-center mt-0.5">
                                  {med.isSpecial && <span className="font-bold uppercase text-[9px] bg-purple-200 text-purple-800 px-1 py-0.5 rounded">Controle</span>}
                                  {med.isDiet && <span className="font-bold uppercase text-[9px] bg-emerald-200 text-emerald-800 px-1 py-0.5 rounded">Dieta</span>}
                                  {med.isTemporary && <span className="font-bold uppercase text-[9px] bg-orange-200 text-orange-800 px-1 py-0.5 rounded">Temp</span>}
                                  <span className="truncate">{med.medName}</span>
                                </div>
                                {med.isTemporary && med.endDate && med.endTime && (
                                  <p className="text-[9px] text-orange-500 mt-1 flex items-center gap-1">
                                    Até {new Date(med.endDate + 'T00:00:00').toLocaleDateString('pt-BR')} às {med.endTime}
                                  </p>
                                )}
                              </div>
                              <div className={`bg-white px-2 sm:px-3 py-1 rounded-lg border shrink-0 ${med.isSpecial ? 'border-purple-200 text-purple-600' : med.isDiet ? 'border-emerald-200 text-emerald-600' : med.isTemporary ? 'border-orange-200 text-orange-600' : 'border-amber-200 text-amber-600'} font-bold text-sm`}>
                                {med.time}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-500 italic py-2">Nenhuma medicação ou dieta programada para esta janela.</p>
                      )}
                    </div>

                    {/* Temporary Meds */}
                    {getRoomMedications(selectedRoomForMeds).temporary.length > 0 && (
                      <div className="space-y-3 pt-4 border-t border-slate-100">
                        <h4 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-orange-500" /> Atenção Contínua (Temporárias)
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {getRoomMedications(selectedRoomForMeds).temporary.map((med, idx) => (
                            <div key={`temp-${idx}`} className="bg-orange-50 p-3 rounded-xl border border-orange-100">
                              <p className="font-bold text-slate-800 text-sm">{med.childName}</p>
                              <p className="text-xs text-orange-700 font-medium mt-0.5 whitespace-pre-line"><span className="font-bold uppercase text-[10px] bg-orange-200 text-orange-800 px-1.5 py-0.5 rounded mr-1 inline-block mb-1">Temp</span> {med.medName}</p>
                              {med.times && med.times.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1 mb-1">
                                  {med.times.map(t => (
                                    <span key={t} className="bg-white text-orange-600 px-1.5 py-0.5 rounded border border-orange-100 text-[10px] font-bold">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {med.endDate && med.endTime && (
                                <p className="text-[10px] text-orange-500 mt-1 flex items-center gap-1">
                                  <Calendar className="w-2.5 h-2.5" /> Até {new Date(med.endDate + 'T00:00:00').toLocaleDateString('pt-BR')} às {med.endTime}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </section>

              <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-indigo-600 font-bold">
                      <Stethoscope className="w-5 h-5" />
                      <span>Solicitações de Consultas/Exames</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex border-b border-slate-200 gap-6 mt-4">
                      <button
                        onClick={() => setMedicalRequestsTab('current')}
                        className={`pb-3 text-sm font-bold transition-all relative ${
                          medicalRequestsTab === 'current' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'
                        }`}
                      >
                        Próximas ({activities.filter(a => a.type === 'medical_request' && (!a.appointmentDate || a.appointmentDate >= getLocalDateString())).length})
                        {medicalRequestsTab === 'current' && (
                          <span className="absolute bottom-[-1px] left-0 w-full h-[2px] bg-indigo-500 rounded-t-full"></span>
                        )}
                      </button>
                      <button
                        onClick={() => setMedicalRequestsTab('archived')}
                        className={`pb-3 text-sm font-bold transition-all relative ${
                          medicalRequestsTab === 'archived' ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-600'
                        }`}
                      >
                        Realizadas
                        {medicalRequestsTab === 'archived' && (
                          <span className="absolute bottom-[-1px] left-0 w-full h-[2px] bg-emerald-500 rounded-t-full"></span>
                        )}
                      </button>
                    </div>

                    {medicalRequestsTab === 'current' && (
                      <button 
                        onClick={() => {
                          setMedicalEventForm({
                            ...medicalEventForm,
                            type: 'medical_request',
                            description: 'Solicitação de consulta com pediatra para avaliação de rotina.'
                          });
                          setIsMedicalEventModalOpen(true);
                        }}
                        className="w-full text-left p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100 hover:bg-indigo-50 transition-all group"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-indigo-900">Nova Solicitação</span>
                          <Plus className="w-4 h-4 text-indigo-400 group-hover:rotate-90 transition-transform" />
                        </div>
                      </button>
                    )}
                    <div className="space-y-2 mt-2">
                      {activities
                        .filter(a => a.type === 'medical_request' && (medicalRequestsTab === 'current' ? (!a.appointmentDate || a.appointmentDate >= getLocalDateString()) : (a.appointmentDate && a.appointmentDate < getLocalDateString())))
                        .sort((a, b) => {
                          if (!a.appointmentDate) return 1;
                          if (!b.appointmentDate) return -1;
                          // For 'current' (Próximas), sort Ascending (closest first)
                          // For 'archived' (Realizadas), sort Descending (newest first)
                          if (medicalRequestsTab === 'current') {
                            return a.appointmentDate.localeCompare(b.appointmentDate);
                          } else {
                            return b.appointmentDate.localeCompare(a.appointmentDate);
                          }
                        })
                        .map(a => (
                        <div 
                          key={a.id} 
                          onClick={() => {
                            const child = profiles.find(p => p.name === a.childName);
                            setMedicalEventForm({
                              id: a.id,
                              type: 'medical_request',
                              childId: child?.id || '',
                              date: a.appointmentDate || getLocalDateString(),
                              time: a.appointmentTime || '',
                              description: a.description
                            });
                            setIsMedicalEventModalOpen(true);
                          }}
                          className={`p-3 bg-slate-50 rounded-xl text-xs flex flex-col gap-1 cursor-pointer hover:bg-slate-100 transition-all border border-transparent ${
                            medicalRequestsTab === 'current' ? 'hover:border-indigo-100' : 'hover:border-emerald-100'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-slate-600 font-bold truncate">{a.childName}</span>
                            <span className="text-[10px] text-slate-400">{new Date(a.timestamp).toLocaleDateString('pt-BR')}</span>
                          </div>
                          <p className="text-slate-500 line-clamp-1">{a.description}</p>
                          {a.appointmentDate && (
                            <div className={`flex items-center gap-1 font-bold mt-1 ${medicalRequestsTab === 'current' ? 'text-indigo-600' : 'text-emerald-600'}`}>
                              <Calendar className="w-3 h-3" />
                              <span>{medicalRequestsTab === 'current' ? 'Agendado: ' : 'Realizado: '}{formatDateBR(a.appointmentDate)}</span>
                              {a.appointmentTime && <span className="ml-1 text-[10px] opacity-75">às {a.appointmentTime}</span>}
                            </div>
                          )}
                        </div>
                      ))}
                      {activities.filter(a => a.type === 'medical_request' && (medicalRequestsTab === 'current' ? (!a.appointmentDate || a.appointmentDate >= getLocalDateString()) : (a.appointmentDate && a.appointmentDate < getLocalDateString()))).length === 0 && (
                        <p className="text-center text-xs text-slate-400 py-4 italic">{medicalRequestsTab === 'current' ? 'Nenhuma solicitação pendente' : 'Nenhuma solicitação realizada'}</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-emerald-600 font-bold">
                      <CalendarCheck className="w-5 h-5" />
                      <span>Consultas/Exames Realizados</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <button 
                        onClick={() => {
                          setMedicalEventForm({
                            ...medicalEventForm,
                            type: 'medical_completed',
                            description: 'Consulta realizada com sucesso. Paciente estável, sem novas recomendações.'
                          });
                          setIsMedicalEventModalOpen(true);
                        }}
                        className="text-left p-4 bg-emerald-50/50 rounded-2xl border border-emerald-100 hover:bg-emerald-50 transition-all group"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-emerald-900">Registrar</span>
                          <Plus className="w-4 h-4 text-emerald-400 group-hover:rotate-90 transition-transform" />
                        </div>
                      </button>
                      <button 
                        onClick={() => setIsReportAIModalOpen(true)}
                        className="text-left p-4 bg-sky-50/50 rounded-2xl border border-sky-100 hover:bg-sky-50 transition-all group"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-sky-900">Relatório AI</span>
                          <FileUp className="w-4 h-4 text-sky-400 group-hover:scale-110 transition-transform" />
                        </div>
                      </button>
                    </div>
                    <div className="space-y-2">
                      {activities.filter(a => a.type === 'medical_completed').slice(0, 3).map(a => (
                        <div 
                          key={a.id} 
                          onClick={() => {
                            const child = profiles.find(p => p.name === a.childName);
                            setMedicalEventForm({
                              id: a.id,
                              type: 'medical_completed',
                              childId: child?.id || '',
                              date: a.appointmentDate || getLocalDateString(),
                              time: a.appointmentTime || '',
                              description: a.description
                            });
                            setIsMedicalEventModalOpen(true);
                          }}
                          className="p-3 bg-slate-50 rounded-xl text-xs flex flex-col gap-1 cursor-pointer hover:bg-slate-100 transition-all border border-transparent hover:border-emerald-100"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-slate-600 font-bold truncate">{a.childName}</span>
                            <span className="text-[10px] text-slate-400">{new Date(a.timestamp).toLocaleDateString('pt-BR')}</span>
                          </div>
                          <p className="text-slate-500 line-clamp-1">{a.description}</p>
                        </div>
                      ))}
                      {activities.filter(a => a.type === 'medical_completed').length === 0 && (
                        <p className="text-center text-xs text-slate-400 py-4 italic">Nenhum registro recente</p>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </motion.div>
          )}

          {activeTab === 'reports' && (
            <motion.div
              key="reports-section"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              {/* Search and Filter Bar */}
              <div className="bg-white p-4 rounded-3xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4">
                <div className="flex-1 relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input 
                    type="text"
                    placeholder="Buscar no histórico..."
                    value={reportSearchQuery}
                    onChange={(e) => setReportSearchQuery(e.target.value)}
                    className="w-full pl-12 pr-4 py-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1 md:flex-none">
                    <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <select 
                      value={reportFilterChildId}
                      onChange={(e) => setReportFilterChildId(e.target.value)}
                      className="pl-9 pr-8 py-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-xs font-bold text-slate-600 appearance-none min-w-[140px]"
                    >
                      <option value="all">Todas as Crianças</option>
                      {profiles.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="relative flex-1 md:flex-none">
                    <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <select 
                      value={reportFilterType}
                      onChange={(e) => setReportFilterType(e.target.value)}
                      className="pl-9 pr-8 py-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-xs font-bold text-slate-600 appearance-none min-w-[140px]"
                    >
                      <option value="all">Todos os Tipos</option>
                      <option value="medication">Prescrições</option>
                      <option value="medical_completed">Exames/Consultas</option>
                      <option value="medical_request">Solicitações</option>
                      <option value="activity">Atividades</option>
                      <option value="incident">Ocorrências</option>
                    </select>
                  </div>
                </div>
              </div>

              {report && (
                <motion.section 
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="bg-white p-8 rounded-3xl shadow-xl border border-sky-100 space-y-6"
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-sky-50 rounded-lg">
                        <FileText className="w-6 h-6 text-sky-500" />
                      </div>
                      <h2 className="text-xl font-bold text-slate-900">{report.title}</h2>
                    </div>
                    <span className="px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded-full flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Gerado com IA
                    </span>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Resumo Executivo</h3>
                      <p className="text-slate-700 leading-relaxed">{report.summary}</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-3">
                        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Recomendações</h3>
                        <ul className="space-y-2">
                          {report.recommendations.map((rec, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                              <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                              {rec}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="space-y-3">
                        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Próximos Passos</h3>
                        <ul className="space-y-2">
                          {report.nextSteps.map((step, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                              <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                              {step}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end pt-4">
                    <button className="text-sky-600 font-bold text-sm hover:underline flex items-center gap-1">
                      Exportar PDF <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </motion.section>
              )}

              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-slate-400" />
                    Histórico Recente
                  </h3>
                  {(reportSearchQuery || reportFilterChildId !== 'all' || reportFilterType !== 'all') && (
                    <button 
                      onClick={() => {
                        setReportSearchQuery('');
                        setReportFilterChildId('all');
                        setReportFilterType('all');
                      }}
                      className="text-xs font-bold text-sky-600 hover:underline"
                    >
                      Limpar Filtros
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3">
                  {filteredActivities.length === 0 ? (
                    <div className="text-center py-12 bg-white rounded-3xl border border-dashed border-slate-200">
                      <Search className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-slate-400 text-sm">Nenhum registro encontrado com os filtros atuais.</p>
                    </div>
                  ) : (
                    <>
                      {filteredActivities.slice(0, visibleActivitiesCount).map((activity) => {
                        const typeLabels: Record<string, string> = {
                          'medication': 'Medicação',
                          'incident': 'Ocorrência',
                          'activity': 'Atividade',
                          'report': 'Relatório',
                          'medical_request': 'Solicitação Médica',
                          'medical_completed': 'Consulta/Exame'
                        };

                        return (
                          <div 
                            key={activity.id}
                            onClick={() => {
                              setSelectedActivity(activity);
                              setEditActivityText(activity.description);
                              setIsEditingActivity(false);
                            }}
                            className="bg-white p-4 rounded-2xl border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between hover:border-sky-200 hover:shadow-md transition-all cursor-pointer group gap-4"
                          >
                            <div className="flex items-start sm:items-center gap-4">
                              <div className={`p-3 rounded-xl shrink-0 ${
                                activity.type === 'medication' ? 'bg-amber-50 text-amber-500' :
                                activity.type === 'incident' ? 'bg-rose-50 text-rose-500' :
                                activity.type === 'activity' ? 'bg-emerald-50 text-emerald-500' :
                                activity.type === 'medical_request' ? 'bg-indigo-50 text-indigo-500' :
                                activity.type === 'medical_completed' ? 'bg-emerald-50 text-emerald-500' :
                                'bg-sky-50 text-sky-500'
                              }`}>
                                {activity.type === 'medication' && <Pill className="w-6 h-6" />}
                                {activity.type === 'incident' && <AlertCircle className="w-6 h-6" />}
                                {activity.type === 'activity' && <Activity className="w-6 h-6" />}
                                {activity.type === 'report' && <FileText className="w-6 h-6" />}
                                {activity.type === 'medical_request' && <Stethoscope className="w-6 h-6" />}
                                {activity.type === 'medical_completed' && <CalendarCheck className="w-6 h-6" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <h4 className="font-bold text-slate-900 text-base truncate">{activity.childName}</h4>
                                  <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded-md uppercase tracking-wider">
                                    {typeLabels[activity.type] || 'Registro'}
                                  </span>
                                </div>
                                <p className="text-sm text-slate-600 line-clamp-2">{activity.description}</p>
                                {activity.authorName && (
                                  <p className="text-[10px] font-bold text-sky-600/60 mt-1 uppercase tracking-wider">
                                    Resp: {activity.authorName}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="text-left sm:text-right flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2 shrink-0 border-t sm:border-t-0 sm:border-l border-slate-100 pt-3 sm:pt-0 sm:pl-4 mt-2 sm:mt-0">
                              <div className="flex flex-col items-start sm:items-end">
                                <span className="text-xs font-bold text-slate-500 flex items-center gap-1">
                                  <Calendar className="w-3.5 h-3.5" />
                                  {new Date(activity.timestamp).toLocaleDateString('pt-BR')}
                                </span>
                                <span className="text-xs font-medium text-slate-400 flex items-center gap-1 mt-0.5">
                                  <Clock className="w-3.5 h-3.5" />
                                  {new Date(activity.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              {activity.status === 'urgent' && (
                                <span className="px-2.5 py-1 bg-rose-100 text-rose-600 text-xs font-bold rounded-full flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" /> Urgente
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {filteredActivities.length > visibleActivitiesCount && (
                        <div className="flex justify-center mt-4">
                          <button
                            onClick={() => setVisibleActivitiesCount(prev => prev + 30)}
                            className="px-6 py-3 bg-white border border-slate-200 text-sky-600 font-bold rounded-xl hover:bg-slate-50 transition-all shadow-sm"
                          >
                            Carregar Mais Registros
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
            </motion.div>
          )}

          {activeTab === 'profiles' && (
            <motion.div
              key="profiles-section"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="flex flex-row flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-slate-900">Os corações do Instituto</h2>
                <div className="flex items-center gap-2">
                  <div className="flex bg-slate-100 p-1 rounded-xl">
                    <button 
                      onClick={() => setProfileViewMode('list')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${profileViewMode === 'list' ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Lista
                    </button>
                    <button 
                      onClick={() => setProfileViewMode('grid')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${profileViewMode === 'grid' ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Cards
                    </button>
                  </div>

                  <select 
                    value={profileFilterRoom}
                    onChange={(e) => setProfileFilterRoom(e.target.value)}
                    className="bg-slate-100 border-none text-xs font-bold text-slate-600 rounded-xl px-3 py-2 focus:ring-2 focus:ring-sky-200 outline-none"
                  >
                    <option value="all">Todas as crianças</option>
                    {ROOM_OPTIONS.map(room => (
                      <option key={room} value={room}>{room}</option>
                    ))}
                  </select>

                  <button 
                    onClick={() => {
                      setEditingProfile(null);
                      setProfileForm({ 
                        name: '', 
                        birthDate: '', 
                        supportDevices: [], 
                        liquidDiet: '', 
                        solidDiet: '', 
                        dietSchedules: [],
                        medicationSchedule: '',
                        sosMedications: '',
                        temporaryMedications: [],
                        currentMedications: [], 
                        recurringMedications: [],
                        specialMedications: [],
                        extracurriculars: [], 
                        preferences: '',
                        room: ROOM_OPTIONS[0]
                      });
                      setTempMedName('');
                      setTempMedStartDate('');
                      setTempMedEndDate('');
                      setTempMedEndTime('');
                      setTempMedTime('');
                      setTempMedTimes([]);
                      setIsProfileModalOpen(true);
                    }}
                    className="bg-sky-500 text-white px-3 py-2 rounded-xl font-bold text-xs flex items-center gap-1.5 hover:bg-sky-600 transition-all shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" /> Adicionar
                  </button>
                </div>
              </div>

              <div className={profileViewMode === 'grid' ? "grid grid-cols-1 md:grid-cols-2 gap-4" : "space-y-3"}>
                {profiles
                  .filter(p => profileFilterRoom === 'all' || p.room === profileFilterRoom)
                  .map((profile) => (
                  profileViewMode === 'grid' ? (
                    <div key={profile.id} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all space-y-4">
                      <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 sm:w-16 sm:h-16 rounded-2xl flex items-center justify-center border-2 shrink-0 ${profile.gender === 'F' ? 'bg-rose-50 border-rose-100' : 'bg-sky-50 border-sky-100'}`}>
                          <Heart className={`w-6 h-6 sm:w-8 sm:h-8 ${profile.gender === 'F' ? 'fill-rose-500 text-rose-500' : 'fill-sky-500 text-sky-500'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-bold text-base sm:text-lg text-slate-900 truncate">{profile.name}</h3>
                          <p className="text-xs text-slate-500">
                            Idade: {calculateAge(profile.birthDate)}
                            {profile.weight && <span className="ml-2 font-medium text-slate-600 tracking-tight">• {profile.weight}kg</span>}
                          </p>
                          {profile.room && <p className="text-[10px] sm:text-xs text-sky-600 font-medium mt-0.5 truncate">{profile.room}</p>}
                        </div>
                        <div className="flex flex-wrap sm:flex-nowrap justify-end gap-1 sm:gap-2">
                          <button 
                            onClick={() => {
                              const sanitizedProfile = {
                                ...profile,
                                temporaryMedications: Array.isArray(profile.temporaryMedications) ? profile.temporaryMedications : []
                              };
                              setEditingProfile(sanitizedProfile as ChildProfile);
                              setProfileForm(sanitizedProfile);
                              setTempMedName('');
                              setTempMedStartDate('');
                              setTempMedEndDate('');
                              setTempMedEndTime('');
                              setTempMedTime('');
                              setTempMedTimes([]);
                              setIsProfileModalOpen(true);
                            }}
                            className="p-2 text-slate-400 hover:text-sky-500 hover:bg-sky-50 rounded-lg transition-all"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => setProfileToDelete(profile)}
                            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => {
                              setVitalSignsForm({ ...vitalSignsForm, childId: profile.id });
                              setIsVitalSignsModalOpen(true);
                            }}
                            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                            title="Registrar Sinais Vitais"
                          >
                            <Activity className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3">
                        <div className="p-3 bg-indigo-50 rounded-2xl space-y-1">
                          <div className="flex items-center gap-1 text-indigo-600 text-[10px] font-bold uppercase">
                            <Stethoscope className="w-3 h-3" /> Dispositivos
                          </div>
                          <p className="text-xs text-indigo-900 font-medium">{profile.supportDevices.join(', ') || 'Nenhum'}</p>
                        </div>
                      </div>

                      {/* Medicações Programadas */}
                      {profile.recurringMedications && profile.recurringMedications.length > 0 && (
                        <div className="p-3 bg-amber-50 rounded-2xl space-y-2">
                          <div className="flex items-center gap-1 text-amber-600 text-[10px] font-bold uppercase">
                            <Pill className="w-3 h-3" /> Medicações Programadas
                          </div>
                          <div className="space-y-1.5">
                            {profile.recurringMedications.map(med => (
                              <div key={med.id} className="flex justify-between items-center bg-white/50 p-1.5 rounded-lg">
                                <span className="text-[10px] font-bold text-amber-900">{med.name}</span>
                                <div className="flex gap-1 flex-wrap justify-end">
                                  {med.times.map(t => (
                                    <span key={t} className="bg-amber-200/50 text-amber-800 text-[9px] font-bold px-1.5 py-0.5 rounded">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Medicações de Controle Especial */}
                      {profile.specialMedications && profile.specialMedications.length > 0 && (
                        <div className="p-3 bg-purple-50 rounded-2xl space-y-2">
                          <div className="flex items-center gap-1 text-purple-600 text-[10px] font-bold uppercase">
                            <AlertCircle className="w-3 h-3" /> Controle Especial (Com Alerta)
                          </div>
                          <div className="space-y-1.5">
                            {profile.specialMedications.map(med => (
                              <div key={med.id} className="flex justify-between items-center bg-white/50 p-1.5 rounded-lg">
                                <span className="text-[10px] font-bold text-purple-900">{med.name}</span>
                                <div className="flex gap-1 flex-wrap justify-end">
                                  {med.times.map(t => (
                                    <span key={t} className="bg-purple-200/50 text-purple-800 text-[9px] font-bold px-1.5 py-0.5 rounded">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="p-3 bg-rose-50 rounded-2xl space-y-1">
                          <div className="flex items-center gap-1 text-rose-600 text-[10px] font-bold uppercase transition-all">
                            <AlertCircle className="w-3 h-3" /> SOS
                          </div>
                          <p className="text-[10px] sm:text-xs text-rose-900 break-words whitespace-pre-line">{profile.sosMedications || 'Nenhum'}</p>
                        </div>
                        <div className="p-3 bg-amber-50 rounded-2xl space-y-1">
                          <div className="flex items-center gap-1 text-amber-600 text-[10px] font-bold uppercase transition-all">
                            <Calendar className="w-3 h-3" /> Temporários
                          </div>
                          <div className="text-[10px] sm:text-xs text-amber-900 space-y-1">
                            {(!profile.temporaryMedications || !Array.isArray(profile.temporaryMedications) || profile.temporaryMedications.length === 0) ? (
                              'Nenhum'
                            ) : (
                              profile.temporaryMedications.map(tm => (
                                <div key={tm.id} className="flex flex-col border-b border-amber-100 last:border-0 pb-1 last:pb-0">
                                  <span className="font-bold">{tm.description}</span>
                                  {tm.times && tm.times.length > 0 && (
                                    <span className="text-amber-600 font-medium">
                                      Horários: {tm.times.join(', ')}
                                    </span>
                                  )}
                                  <span className="opacity-70 text-[9px]">
                                    {new Date(tm.startDate + 'T00:00:00').toLocaleDateString('pt-BR')} até {new Date(tm.endDate + 'T00:00:00').toLocaleDateString('pt-BR')} {tm.endTime}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Dietas Programadas */}
                      {profile.dietSchedules && profile.dietSchedules.length > 0 && (
                        <div className="p-3 bg-emerald-50 rounded-2xl space-y-2">
                          <div className="flex items-center gap-1 text-emerald-600 text-[10px] font-bold uppercase">
                            <Activity className="w-3 h-3" /> Dietas Programadas
                          </div>
                          <div className="grid grid-cols-1 gap-1.5">
                            {profile.dietSchedules.map(diet => (
                              <div key={diet.id} className="flex justify-between items-center bg-white/50 p-1.5 rounded-lg gap-2">
                                <span className="text-[10px] font-bold text-emerald-900 break-words flex-1">{diet.description}</span>
                                <div className="flex gap-1 flex-wrap justify-end shrink-0">
                                  {diet.times.map(t => (
                                    <span key={t} className="bg-emerald-200/50 text-emerald-800 text-[9px] font-bold px-1.5 py-0.5 rounded">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {(profile.liquidDiet || profile.solidDiet) && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {profile.liquidDiet && (
                            <div className="p-3 bg-sky-50 rounded-2xl space-y-1">
                              <div className="flex items-center gap-1 text-sky-600 text-[10px] font-bold uppercase">
                                <Activity className="w-3 h-3" /> Obs. Dieta Líquida
                              </div>
                              <p className="text-xs text-sky-900 break-words">{profile.liquidDiet}</p>
                            </div>
                          )}
                          {profile.solidDiet && (
                            <div className="p-3 bg-emerald-50 rounded-2xl space-y-1">
                              <div className="flex items-center gap-1 text-emerald-600 text-[10px] font-bold uppercase">
                                <Activity className="w-3 h-3" /> Obs. Dieta Sólida
                              </div>
                              <p className="text-xs text-emerald-900 break-words">{profile.solidDiet}</p>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase">
                          <Activity className="w-3 h-3" /> Informações importantes
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {profile.extracurriculars.map((ext, i) => (
                            <span key={i} className="px-2 py-1 bg-emerald-50 text-emerald-700 text-[10px] font-bold rounded-full">
                              {ext}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="p-3 bg-slate-50 rounded-2xl">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase mb-1">
                          <Heart className="w-3 h-3" /> Principais patologias clínicas
                        </div>
                        <p className="text-xs text-slate-600 italic">"{profile.preferences}"</p>
                      </div>

                      {profile.latestPrescriptionImage && (
                        <div className="pt-2">
                          <button 
                            onClick={() => setFullscreenImage(profile.latestPrescriptionImage as string)}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all"
                          >
                            <ImageIcon className="w-4 h-4" /> Ver Última Prescrição
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div key={profile.id} className="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4 hover:bg-slate-50 transition-all">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${profile.gender === 'F' ? 'bg-rose-50 border-rose-100' : 'bg-sky-50 border-sky-100'}`}>
                        <Heart className={`w-5 h-5 ${profile.gender === 'F' ? 'fill-rose-500 text-rose-500' : 'fill-sky-500 text-sky-500'}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-sm text-slate-900 truncate">{profile.name}</h3>
                        <p className="text-[10px] text-slate-500">
                          {calculateAge(profile.birthDate)}
                          {profile.weight && <span className="ml-2 font-medium text-slate-600 tracking-tight">• {profile.weight}kg</span>}
                          {profile.room && <span className="ml-2 text-sky-600 font-medium">{profile.room}</span>}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        {profile.latestPrescriptionImage && (
                          <button 
                            onClick={() => setFullscreenImage(profile.latestPrescriptionImage as string)}
                            className="p-1.5 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                            title="Ver Última Prescrição"
                          >
                            <ImageIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button 
                          onClick={() => {
                            const sanitizedProfile = {
                              ...profile,
                              temporaryMedications: Array.isArray(profile.temporaryMedications) ? profile.temporaryMedications : []
                            };
                            setEditingProfile(sanitizedProfile as ChildProfile);
                            setProfileForm(sanitizedProfile);
                            setTempMedName('');
                            setTempMedStartDate('');
                            setTempMedEndDate('');
                            setTempMedEndTime('');
                            setTempMedTime('');
                            setTempMedTimes([]);
                            setIsProfileModalOpen(true);
                          }}
                          className="p-1.5 text-slate-400 hover:text-sky-500 hover:bg-sky-50 rounded-lg transition-all"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => setProfileToDelete(profile)}
                          className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => {
                            setVitalSignsForm({ ...vitalSignsForm, childId: profile.id });
                            setIsVitalSignsModalOpen(true);
                          }}
                          className="p-1.5 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                          title="Registrar Sinais Vitais"
                        >
                          <Activity className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            </motion.div>
          )}

          {activeTab === 'shift-report' && (
            <motion.div
              key="shift-report-section"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold text-slate-900">Gerador Automático de Relatório</h2>
              </div>

              <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 flex flex-col gap-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Data do Plantão (07h às 07h)</label>
                    <input 
                      type="date"
                      value={autoReportParams.date}
                      onChange={(e) => setAutoReportParams({...autoReportParams, date: e.target.value})}
                      className="w-full p-3 bg-slate-50 rounded-xl border border-slate-200 focus:ring-2 focus:ring-sky-200 text-sm font-bold text-slate-600"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Enfermaria</label>
                    <select 
                      value={autoReportParams.room || myActiveRoom || ROOM_OPTIONS[0]}
                      onChange={(e) => {
                        const r = e.target.value;
                        const lastR = shiftReports.filter(sr => sr.room === r).sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                        setAutoReportParams({...autoReportParams, room: r, staff: lastR?.staff || ''});
                      }}
                      className="w-full p-3 bg-slate-50 rounded-xl border border-slate-200 focus:ring-2 focus:ring-sky-200 text-sm font-bold text-slate-600 appearance-none"
                    >
                      {ROOM_OPTIONS.map(room => (
                        <option key={room} value={room}>{room}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <label className="text-xs font-bold text-slate-400 uppercase">Responsável pelo Plantão</label>
                    <input 
                      type="text"
                      value={user?.displayName || 'Sistema'}
                      readOnly={true}
                      className="w-full p-3 bg-slate-100 rounded-xl border border-slate-200 text-sm text-slate-500 font-medium cursor-not-allowed"
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <label className="text-xs font-bold text-slate-400 uppercase">Avisos e Informações Gerais da Enfermaria</label>
                    <textarea 
                      placeholder="Anotações gerais do plantão que não são específicas a uma criança..."
                      value={autoReportParams.generalInfo}
                      onChange={(e) => setAutoReportParams({...autoReportParams, generalInfo: e.target.value})}
                      className="w-full p-3 bg-slate-50 rounded-xl border border-slate-200 focus:ring-2 focus:ring-sky-200 text-sm text-slate-700 min-h-[80px]"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-100 flex flex-col md:flex-row justify-between items-center gap-4">
                  <p className="text-xs text-slate-400">
                    O relatório é gerado automaticamente a partir das atividades lançadas entre as 07h do dia selecionado e as 07h do dia seguinte.
                  </p>
                  <button 
                    onClick={async () => {
                      const text = generateVirtualShiftReport();
                      
                      let success = false;
                      try {
                        const targetRoom = autoReportParams.room || myActiveRoom || ROOM_OPTIONS[0];
                        const defaultDate = autoReportParams.date || getShiftDateString();
                        const reportObj = generateShiftReportObject(targetRoom, defaultDate, user?.displayName || 'Sistema', autoReportParams.generalInfo, user?.uid || 'sistema_automatico');
                        const dateSlug = (defaultDate || '').replace(/[^a-z0-9]/gi, '-');
                        const roomSlug = (targetRoom || '').toLowerCase().replace(/[^a-z0-9]/gi, '-');
                        const houseSlug = 'solar-meimei';
                        reportObj.id = `shift_${houseSlug}_${roomSlug}_${dateSlug}`;
                        
                        const reportRef = doc(db, 'shiftReports', reportObj.id);
                        await setDoc(reportRef, reportObj);
                        success = true;
                      } catch (error) {
                        console.error('Erro ao salvar plantão automaticamente:', error);
                      }

                      if (success) {
                        copyToClipboard(text, 'Relatório copiado e salvo no histórico!');
                      } else {
                        copyToClipboard(text, 'Relatório copiado, mas houve um erro ao salvá-lo.');
                      }
                    }}
                    className="flex shrink-0 items-center gap-2 px-6 py-3 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-600 transition-all shadow-md shadow-emerald-200"
                  >
                    <ClipboardList className="w-4 h-4" /> Copiar Relatório
                  </button>
                </div>

                <div className="bg-slate-50 rounded-2xl p-6 relative border border-slate-200 mt-2">
                  <div className="absolute top-0 right-0 p-4 opacity-10">
                    <ClipboardList className="w-16 h-16" />
                  </div>
                  <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 leading-relaxed font-medium relative z-10">
                    {generateVirtualShiftReport()}
                  </pre>
                </div>
              </div>

              <div className="mt-10 mb-4 flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-900">Histórico de Relatórios</h2>
              </div>

              {/* Shift Report Filters */}
              <div className="bg-white p-4 rounded-3xl shadow-sm border border-slate-100 flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <div className="relative flex-1 md:flex-none min-w-[140px]">
                    <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input 
                      type="date"
                      value={shiftReportFilterDate}
                      onChange={(e) => setShiftReportFilterDate(e.target.value)}
                      className="w-full pl-9 pr-4 py-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-xs font-bold text-slate-600"
                    />
                  </div>
                  <div className="relative flex-1 md:flex-none min-w-[140px]">
                    <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <select 
                      value={shiftReportFilterResponsible}
                      onChange={(e) => setShiftReportFilterResponsible(e.target.value)}
                      className="w-full pl-9 pr-8 py-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-xs font-bold text-slate-600 appearance-none"
                    >
                      <option value="all">Todos os Responsáveis</option>
                      {uniqueShiftResponsibles.map(staff => (
                        <option key={staff} value={staff}>{staff}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {(shiftReportFilterDate !== '' || shiftReportFilterResponsible !== 'all') && (
                  <button 
                    onClick={() => {
                      setShiftReportFilterDate('');
                      setShiftReportFilterResponsible('all');
                    }}
                    className="text-xs font-bold text-sky-600 hover:underline self-end"
                  >
                    Limpar Filtros
                  </button>
                )}
              </div>

              <div className="space-y-4">
                {filteredShiftReports.length === 0 ? (
                  <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-slate-200">
                    <ClipboardList className="w-12 h-12 text-slate-200 mx-auto mb-4" />
                    <p className="text-slate-400 font-medium">Nenhum relatório de plantão encontrado no histórico.</p>
                  </div>
                ) : (
                  filteredShiftReports.map((report) => (
                    <div key={report.id} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <h3 className="font-bold text-slate-900">Plantão: {report.room}</h3>
                          <p className="text-xs text-slate-500">{formatDateBR(report.date)} - {report.staff || 'Sem responsáveis'}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button 
                            onClick={() => setSelectedReport(report)}
                            className="flex items-center gap-2 px-3 py-1.5 bg-sky-50 text-sky-600 rounded-lg text-xs font-bold hover:bg-sky-100 transition-all"
                          >
                            <Eye className="w-3 h-3" /> Visualizar
                          </button>
                          <button 
                            onClick={() => {
                              const text = formatShiftReportForWhatsApp(report);
                              copyToClipboard(text);
                            }}
                            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-bold hover:bg-emerald-100 transition-all"
                          >
                            <ClipboardList className="w-3 h-3" /> Copiar para WhatsApp
                          </button>
                          {isShiftReportEditable(report) && (
                            <>
                              <button 
                                onClick={() => handleEditShiftReport(report)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-600 rounded-lg text-xs font-bold hover:bg-amber-100 transition-all"
                              >
                                <Edit3 className="w-3 h-3" /> Editar
                              </button>
                              <button 
                                onClick={() => setReportToDelete(report)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-rose-50 text-rose-600 rounded-lg text-xs font-bold hover:bg-rose-100 transition-all"
                              >
                                <Trash2 className="w-3 h-3" /> Excluir
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {report.childrenData.map((child, i) => (
                          <span key={i} className="px-2 py-1 bg-sky-50 text-sky-600 text-[10px] font-bold rounded-full">
                            {child.childName}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'notifications' && (
            <motion.div
              key="notifications-section"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold text-slate-900">Mural de Lembretes</h2>
                <button 
                  onClick={() => setIsNotificationModalOpen(true)}
                  className="bg-sky-500 text-white px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-sky-600 transition-all shrink-0 whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" /> Novo lembrete
                </button>
              </div>

              <div className="flex border-b border-slate-200 gap-6">
                <button
                  onClick={() => setNotificationTab('current')}
                  className={`pb-3 text-sm font-bold transition-all relative ${
                    notificationTab === 'current' ? 'text-sky-600' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  Recentes
                  {notificationTab === 'current' && (
                    <span className="absolute bottom-[-1px] left-0 w-full h-[2px] bg-sky-500 rounded-t-full"></span>
                  )}
                </button>
                <button
                  onClick={() => setNotificationTab('archived')}
                  className={`pb-3 text-sm font-bold transition-all relative ${
                    notificationTab === 'archived' ? 'text-slate-800' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  Arquivados ({archivedNotifications.length})
                  {notificationTab === 'archived' && (
                    <span className="absolute bottom-[-1px] left-0 w-full h-[2px] bg-slate-800 rounded-t-full"></span>
                  )}
                </button>
              </div>

              <div className="space-y-4">
                {displayedNotifications.length === 0 ? (
                  <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-slate-200">
                    <BellRing className="w-12 h-12 text-slate-200 mx-auto mb-4" />
                    <p className="text-slate-400 font-medium">
                      {notificationTab === 'current' ? 'Nenhum lembrete agendado.' : 'Nenhum lembrete arquivado.'}
                    </p>
                  </div>
                ) : (
                  displayedNotifications.map((notif) => (
                    <div 
                      key={notif.id} 
                      className={`bg-white p-5 rounded-3xl border transition-all flex items-start gap-4 ${
                        notif.isRead ? 'border-slate-100 opacity-75' : 'border-sky-100 shadow-sm'
                      }`}
                    >
                      <div className={`p-3 rounded-2xl ${
                        notif.type === 'medical' ? 'bg-rose-50 text-rose-500' :
                        notif.type === 'medication_checkout' ? 'bg-purple-50 text-purple-500' :
                        notif.type === 'report' ? 'bg-sky-50 text-sky-500' :
                        notif.type === 'activity' ? 'bg-emerald-50 text-emerald-500' :
                        'bg-slate-50 text-slate-500'
                      }`}>
                        {notif.type === 'medical' && <Stethoscope className="w-6 h-6" />}
                        {notif.type === 'medication_checkout' && <AlertCircle className="w-6 h-6" />}
                        {notif.type === 'report' && <FileText className="w-6 h-6" />}
                        {notif.type === 'activity' && <Activity className="w-6 h-6" />}
                        {notif.type === 'other' && <Bell className="w-6 h-6" />}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="font-bold text-slate-900">{notif.title}</h3>
                          <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-1 rounded-full flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> 
                            {notif.startDate && notif.endDate && notif.startDate !== notif.endDate ? (
                              `${formatDateBR(notif.startDate)} até ${formatDateBR(notif.endDate)}`
                            ) : (
                              formatDateBR(notif.date)
                            )} às {notif.time}
                          </span>
                        </div>
                        <p className="text-sm text-slate-500">{notif.description}</p>
                        
                        {notif.imageUrl && (
                          <div className="mt-3 relative w-full h-40 rounded-2xl overflow-hidden border border-slate-100 bg-slate-50">
                            <img 
                              src={notif.imageUrl} 
                              alt="Anexo" 
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                            <button 
                              onClick={() => {
                                setFullscreenImage(notif.imageUrl || null);
                              }}
                              className="absolute bottom-2 right-2 p-2 bg-white/90 backdrop-blur shadow-sm rounded-xl text-slate-600 hover:text-sky-600 transition-all"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                          </div>
                        )}

                          <div className="flex flex-col items-end mt-3 gap-2">
                            <div className="flex justify-end gap-2 w-full">
                              {notif.type === 'medication_checkout' && (
                                <button 
                                  onClick={() => downloadICS(notif)}
                                  className="text-[10px] font-bold text-indigo-500 hover:text-indigo-700 flex items-center gap-1"
                                >
                                  <CalendarCheck className="w-3 h-3" /> Criar Alarme
                                </button>
                              )}
                            {(() => {
                              const userFirstName = user?.displayName ? user.displayName.trim().split(' ')[0] : (user?.email ? user.email.split('@')[0] : 'Desconhecido');
                              const isAlreadyRead = notif.readBy?.some(r => 
                                (user?.uid && r.uid === user.uid) || r.name === userFirstName
                              );
                              
                              return (
                                <button 
                                  disabled={isAlreadyRead}
                                  onClick={async () => {
                                    if (isAlreadyRead) return;

                                    const readInfo = {
                                      uid: user?.uid || 'anonymous',
                                      name: userFirstName,
                                      timestamp: new Date().toISOString()
                                    };
                                    const updatedNotif = { 
                                      ...notif, 
                                      isRead: true,
                                      readBy: [...(notif.readBy || []), readInfo]
                                    };

                                    if (user) {
                                      try {
                                        await setDoc(doc(db, 'notifications', updatedNotif.id), removeUndefined(updatedNotif));
                                      } catch (error) {
                                        handleFirestoreError(error, OperationType.WRITE, `notifications/${updatedNotif.id}`);
                                      }
                                    } else {
                                      setNotifications(notifications.map(n => n.id === notif.id ? updatedNotif : n));
                                    }
                                  }}
                                  className={`text-[10px] font-bold transition-colors ${
                                    isAlreadyRead
                                      ? 'text-emerald-500 cursor-default'
                                      : 'text-sky-600 hover:underline cursor-pointer'
                                  }`}
                                >
                                  {isAlreadyRead ? 'Lido' : 'Marcar como lido'}
                                </button>
                              );
                            })()}
                              {(myActiveRoom === ADMIN_ROOM || !user || notif.authorUid === user.uid) && (
                                <button 
                                  onClick={() => setNotifToDelete(notif)}
                                  className="text-[10px] font-bold text-rose-400 hover:text-rose-600"
                                >
                                  Excluir
                                </button>
                              )}
                            </div>

                            {notif.readBy && notif.readBy.filter(r => r.name !== 'Solar Meimei').length > 0 && (
                              <div className="flex flex-wrap justify-end gap-1 mt-1">
                                {myActiveRoom === ADMIN_ROOM ? (
                                  notif.readBy.filter(r => r.name !== 'Solar Meimei').map((read, idx) => (
                                    <div key={idx} className="flex items-center gap-1 bg-emerald-50 text-emerald-700 text-[8px] px-1.5 py-0.5 rounded-full border border-emerald-100">
                                      <CheckCircle2 className="w-2 h-2" />
                                      <span>Lido por <strong>{read.name}</strong></span>
                                    </div>
                                  ))
                                ) : (
                                  <div className="flex items-center gap-1 text-emerald-500 text-[10px] font-bold">
                                    <CheckCircle2 className="w-3 h-3" /> Visualizado
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'search' && (
            <motion.div
              key="search-section"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex flex-col h-[60vh] md:h-[80vh]"
            >
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar p-1 pb-4">
                {searchMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-start h-full text-center space-y-4 pt-4 pb-8">
                    <div className="w-20 h-20 bg-indigo-100 rounded-3xl flex items-center justify-center animate-bounce">
                      <Sparkles className="w-10 h-10 text-indigo-500" />
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-3xl font-black text-slate-900 tracking-tight">Qual sua dúvida?</h2>
                      <p className="text-slate-500 max-w-sm font-medium mx-auto">
                        Pergunte sobre medicações, evoluções de crianças ou relatórios de plantão. Eu busco em todo o banco de dados.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg mx-auto">
                      {[
                        "Quais os remédios da Luiza?",
                        "Como foi o plantão da Tomas?",
                        "Quem tomou morfina hoje?"
                      ].map(prompt => (
                        <button 
                          key={prompt}
                          onClick={() => {
                            setSearchQuery(prompt);
                          }}
                          className="p-3 bg-white border border-slate-100 rounded-2xl text-xs font-bold text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 transition-all text-left flex items-center gap-2"
                        >
                          <HelpCircle className="w-3 h-3 text-indigo-400" />
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  searchMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] p-4 rounded-3xl relative group ${
                        msg.role === 'user' 
                          ? 'bg-indigo-500 text-white rounded-tr-none shadow-lg shadow-indigo-100' 
                          : 'bg-white border border-slate-100 text-slate-700 rounded-tl-none shadow-sm'
                      }`}>
                        {msg.role === 'ai' && (
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2 text-indigo-500">
                              <Sparkles className="w-4 h-4 fill-indigo-500" />
                              <span className="text-[10px] font-black uppercase tracking-widest">Inteligência Artificial</span>
                            </div>
                            <button 
                              onClick={() => {
                                navigator.clipboard.writeText(msg.content);
                                setCopiedIndex(i);
                                setTimeout(() => setCopiedIndex(null), 2000);
                              }}
                              className="p-1 px-2 flex items-center gap-1.5 bg-slate-50 hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 rounded-lg transition-all border border-slate-100 hover:border-indigo-100 active:scale-95"
                              title="Copiar resposta"
                            >
                              {copiedIndex === i ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  <span className="text-[10px] font-bold">Copiado</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span className="text-[10px] font-bold">Copiar</span>
                                </>
                              )}
                            </button>
                          </div>
                        )}
                        <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    </div>
                  ))
                )}
                {isSearching && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-slate-100 p-4 rounded-3xl rounded-tl-none flex items-center gap-3">
                      <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
                      <span className="text-xs font-bold text-slate-400 animate-pulse">Consultando banco de dados...</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-auto flex gap-2 items-end shrink-0 p-1 pb-6 md:pb-1">
                <div className={`flex-1 bg-white rounded-2xl border border-slate-200 shadow-sm flex items-start px-4 transition-all duration-300 ${isInputFocused || searchQuery ? 'h-32 py-3' : 'h-14 py-4'}`}>
                  <textarea 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAISearch();
                      }
                    }}
                    onFocus={() => setIsInputFocused(true)}
                    onBlur={() => setIsInputFocused(false)}
                    placeholder="Pergunte ao assistente..."
                    className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-bold text-slate-700 p-0 resize-none h-full"
                  />
                </div>
                <button 
                  onClick={handleAISearch}
                  disabled={isSearching || !searchQuery.trim()}
                  className="w-14 h-14 bg-indigo-500 text-white rounded-full flex items-center justify-center hover:bg-indigo-600 shadow-lg shadow-indigo-100 transition-all active:scale-90 disabled:opacity-40 shrink-0"
                >
                  <Send className="w-6 h-6" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
          </>
        )}

      {/* Active Medication Reminder Modal */}
      <AnimatePresence>
        {myActiveRoom && myActiveRoom !== ADMIN_ROOM && activeMedicationReminders.length > 0 && medicationNotificationsEnabled && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border-4 border-purple-400 max-h-[90vh] flex flex-col"
            >
              <div className="flex items-center gap-4 mb-6 shrink-0">
                <div className="p-4 bg-purple-100 text-purple-600 rounded-2xl animate-pulse">
                  <Pill className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-slate-900">Hora da Medicação!</h2>
                  <p className="text-slate-500 font-medium">
                    {activeMedicationReminders.length} check-out{activeMedicationReminders.length > 1 ? 's' : ''} pendente{activeMedicationReminders.length > 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              
              <div className="overflow-y-auto flex-1 space-y-4 min-h-0 pr-1 custom-scrollbar">
                {activeMedicationReminders.map(notif => {
                  const isLate = isMedicationLate(notif);
                  return (
                    <div key={notif.id} className="bg-slate-50 p-3 sm:p-4 rounded-2xl border border-slate-200">
                      <h3 className="font-bold text-base sm:text-lg text-slate-800 mb-1 leading-tight">{notif.title}</h3>
                      <p className="text-slate-600 text-[10px] sm:text-xs mb-3 italic">{notif.time} - {formatDateBR(notif.date)}</p>
                      <p className="text-slate-600 text-xs sm:text-sm mb-4 break-words font-medium">{notif.description}</p>
                      
                      {isLate && (
                        <div className="mb-4 bg-rose-50 p-2 sm:p-3 rounded-xl border border-rose-100">
                          <label className="text-[10px] font-bold text-rose-600 uppercase flex items-center gap-1 mb-1.5">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            Atraso Detectado
                          </label>
                          <textarea
                            value={medicationJustifications[notif.id] || ''}
                            onChange={(e) => setMedicationJustifications(prev => ({ ...prev, [notif.id]: e.target.value }))}
                            placeholder="Justifique o motivo do atraso..."
                            className="w-full p-2 text-xs bg-white border border-rose-200 rounded-lg focus:ring-2 focus:ring-rose-300 outline-none resize-none"
                            rows={2}
                          />
                        </div>
                      )}

                      <button
                        onClick={() => handleAcknowledgeMedication(notif)}
                        disabled={isLate && (!medicationJustifications[notif.id] || medicationJustifications[notif.id].trim() === '')}
                        className="w-full py-2.5 sm:py-3 bg-purple-500 text-white rounded-xl font-bold hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-md shadow-purple-500/20 text-xs sm:text-sm"
                      >
                        <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5" />
                        Confirmar Administração
                      </button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Prescription Modal */}
      <AnimatePresence>
        {isPrescriptionModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 bg-sky-50 border-b border-sky-100 flex items-center justify-between shrink-0">
                <div>
                  <h3 className="text-2xl font-bold text-sky-900">Upload de Prescrição</h3>
                  <p className="text-sm text-sky-600 font-medium">Anexe uma foto da prescrição médica ao perfil da criança</p>
                </div>
                <button onClick={() => setIsPrescriptionModalOpen(false)} className="p-2 hover:bg-sky-200 rounded-full transition-all">
                  <X className="w-6 h-6 text-sky-600" />
                </button>
              </div>

              <div className="p-8 space-y-6 overflow-y-auto min-h-0">
                {!prescriptionImage && !isPrescriptionProcessing && (
                  <div className="border-2 border-dashed border-sky-200 rounded-[2rem] p-12 text-center space-y-4 bg-sky-50/30">
                    <div className="w-20 h-20 bg-sky-100 text-sky-500 rounded-full flex items-center justify-center mx-auto">
                      <FileUp className="w-10 h-10" />
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-900">Selecione a imagem da prescrição</h4>
                      <p className="text-sm text-slate-500">Tire uma foto nítida da prescrição médica</p>
                    </div>
                    <label className="inline-block px-8 py-3 bg-sky-500 text-white font-bold rounded-2xl cursor-pointer hover:bg-sky-600 transition-all shadow-lg shadow-sky-100">
                      Escolher Arquivo
                      <input type="file" accept="image/*" onChange={handlePrescriptionUpload} className="hidden" />
                    </label>
                  </div>
                )}

                {isPrescriptionProcessing && (
                  <div className="py-20 text-center space-y-4">
                    <Loader2 className="w-12 h-12 text-sky-500 animate-spin mx-auto" />
                    <p className="text-slate-500 font-medium animate-pulse">Processando imagem...</p>
                  </div>
                )}

                {prescriptionImage && (
                  <div className="space-y-6">
                    <div className="p-6 bg-emerald-50 rounded-3xl border border-emerald-100 space-y-4">
                      <div className="flex items-center gap-3 text-emerald-700">
                        <CheckCircle2 className="w-6 h-6" />
                        <h4 className="font-bold">Imagem Carregada</h4>
                      </div>
                      
                      <div className="space-y-4">
                        <div className="flex justify-center">
                          <img 
                            src={`data:${prescriptionMimeType};base64,${prescriptionImage}`} 
                            alt="Prescrição" 
                            className="max-h-64 rounded-xl border border-emerald-200 shadow-sm"
                          />
                        </div>

                        <div>
                          <label className="text-sm font-bold text-slate-700">Vincular a um Perfil</label>
                          <select 
                            className="w-full mt-1 p-3 bg-white rounded-xl border border-slate-200 focus:ring-2 focus:ring-sky-200 text-sm"
                            value={matchedProfileId || ''}
                            onChange={(e) => setMatchedProfileId(e.target.value)}
                          >
                            <option value="">{profiles.length === 0 ? 'Carregando crianças...' : 'Selecione a criança...'}</option>
                            {profiles
                              .filter(p => !myActiveRoom || myActiveRoom === ADMIN_ROOM || (myActiveRoom === 'Internação Temporária' ? p.id === internedChildId : p.room === myActiveRoom))
                              .map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3">
                      <button 
                        onClick={() => {
                          setPrescriptionImage(null);
                          setMatchedProfileId(null);
                        }}
                        className="w-full py-4 bg-slate-100 text-slate-600 font-bold rounded-2xl hover:bg-slate-200 transition-all"
                      >
                        Tentar Novamente
                      </button>
                      <button 
                        onClick={handleConfirmPrescription}
                        disabled={!matchedProfileId || isPrescriptionProcessing}
                        className="w-full py-4 bg-sky-500 text-white font-bold rounded-2xl hover:bg-sky-600 shadow-lg shadow-sky-100 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                      >
                        {isPrescriptionProcessing ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Salvando...
                          </>
                        ) : (
                          "Confirmar e Anexar ao Perfil"
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Legacy Report Modal */}
      <AnimatePresence>
        {isLegacyReportModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 bg-purple-50 border-b border-purple-100 flex items-center justify-between shrink-0">
                <div>
                  <h3 className="text-2xl font-bold text-purple-900 text-sm sm:text-2xl">Histórico Legado</h3>
                  <p className="text-xs sm:text-sm text-purple-600 font-medium">Relatórios antigos para análise da IA</p>
                </div>
                <button onClick={() => setIsLegacyReportModalOpen(false)} className="p-2 hover:bg-purple-200 rounded-full transition-all">
                  <X className="w-6 h-6 text-purple-600" />
                </button>
              </div>

              <div className="p-6 sm:p-8 space-y-6 overflow-y-auto min-h-0">
                {!legacyReportAnalysis ? (
                  <>
                    <div className="space-y-2">
                      <label className="block text-xs font-black uppercase text-slate-500">Data do Relatório:</label>
                      <input 
                        type="date"
                        value={legacyReportForm.date}
                        onChange={(e) => setLegacyReportForm({ ...legacyReportForm, date: e.target.value })}
                        className="w-full p-4 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-purple-200 text-sm"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="block text-xs font-black uppercase text-slate-500">Conteúdo do Relatório:</label>
                      <textarea 
                        placeholder="Cole o texto do relatório aqui ou faça upload de uma imagem do documento abaixo..."
                        value={legacyReportForm.content}
                        onChange={(e) => setLegacyReportForm({ ...legacyReportForm, content: e.target.value })}
                        className="w-full p-4 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-purple-200 text-sm min-h-[120px] resize-none"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="block text-xs font-black uppercase text-slate-500">Imagem do Documento:</label>
                      {!legacyReportForm.imageUrl ? (
                        <div className="border-2 border-dashed border-purple-200 rounded-2xl p-6 text-center space-y-3 bg-purple-50/20">
                          <FileImage className="w-8 h-8 text-purple-400 mx-auto" />
                          <label className="inline-block px-6 py-2 bg-purple-500 text-white text-xs font-bold rounded-xl cursor-pointer hover:bg-purple-600 transition-all">
                            Anexar Scan/Foto
                            <input type="file" accept="image/*" onChange={handleLegacyReportImageUpload} className="hidden" />
                          </label>
                        </div>
                      ) : (
                        <div className="relative group">
                          <img 
                            src={`data:${legacyReportForm.mimeType || 'image/jpeg'};base64,${legacyReportForm.imageUrl}`} 
                            alt="Scan" 
                            className="w-full h-32 object-contain rounded-2xl border border-purple-200 bg-black/5"
                          />
                          <button 
                            onClick={() => setLegacyReportForm({ ...legacyReportForm, imageUrl: undefined, mimeType: undefined })}
                            className="absolute top-2 right-2 p-1 bg-rose-500 text-white rounded-full shadow-lg"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    <button 
                      onClick={analyzeLegacyReport}
                      disabled={isAnalyzingLegacyReport || (!legacyReportForm.content && !legacyReportForm.imageUrl)}
                      className="w-full py-4 bg-purple-600 text-white font-bold rounded-2xl hover:bg-purple-700 transition-all shadow-lg shadow-purple-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {isAnalyzingLegacyReport ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Analisando com IA...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-5 h-5" />
                          Analisar com IA
                        </>
                      )}
                    </button>
                  </>
                ) : (
                  <div className="space-y-6">
                    <div className="p-5 bg-emerald-50 rounded-3xl border border-emerald-100 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-emerald-700 font-bold text-sm">
                          <Sparkles className="w-5 h-5" />
                          Análise IA
                        </div>
                        <button 
                          onClick={() => setLegacyReportAnalysis(null)}
                          className="text-[10px] text-emerald-600 hover:underline font-bold"
                        >
                          Refazer
                        </button>
                      </div>
                      
                      <div className="bg-white/50 p-4 rounded-xl border border-emerald-100 text-xs text-slate-700 whitespace-pre-line leading-relaxed max-h-[300px] overflow-y-auto">
                        {legacyReportAnalysis}
                      </div>
                      
                      <p className="text-[10px] text-emerald-600 italic">
                        * Estas informações servirão apenas para alimentar a base de dados histórica da enfermaria para a IA.
                      </p>
                    </div>

                    <div className="flex gap-3">
                      <button 
                        onClick={() => setLegacyReportAnalysis(null)}
                        className="flex-1 py-4 border border-slate-200 text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-all text-sm"
                      >
                        Voltar
                      </button>
                      <button 
                       onClick={saveLegacyReport}
                        disabled={isAnalyzingLegacyReport}
                        className="flex-[2] py-4 bg-emerald-500 text-white font-bold rounded-2xl hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 text-sm"
                      >
                        {isAnalyzingLegacyReport ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <Save className="w-5 h-5" />
                        )}
                        Salvar Histórico
                       </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isShiftReportModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2rem] shadow-2xl w-full max-w-4xl overflow-hidden my-8"
            >
              <div className="p-4 bg-sky-50 border-b border-sky-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-sky-900">
                  {currentShiftReport.id ? 'Editar Relatório de Plantão' : 'Novo Relatório de Plantão'}
                </h3>
                <button onClick={() => setIsShiftReportModalOpen(false)} className="p-1.5 hover:bg-sky-200 rounded-full transition-all">
                  <X className="w-5 h-5 text-sky-600" />
                </button>
              </div>
              <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Data do Relatório</label>
                    <input 
                      type="date" 
                      value={currentShiftReport.date}
                      onChange={(e) => setCurrentShiftReport({ ...currentShiftReport, date: e.target.value })}
                      className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Responsável pelo Plantão</label>
                    <input 
                      type="text" 
                      value={user?.displayName || 'Sistema'}
                      readOnly={true}
                      className="w-full p-3 bg-slate-100 rounded-xl border border-slate-200 text-sm text-slate-500 font-medium cursor-not-allowed"
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                    <h4 className="font-bold text-slate-900 flex items-center gap-2">
                       Crianças - {currentShiftReport.room}
                    </h4>
                  </div>

                  <div className="space-y-3">
                    {currentShiftReport.childrenData?.map((child, index) => (
                      <div key={index} className="bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden transition-all">
                        <div 
                          onClick={() => {
                            const isExpanding = expandedChildIndex !== index;
                            setExpandedChildIndex(isExpanding ? index : null);
                            if (isExpanding) {
                              refreshChildShiftData(index);
                            }
                          }}
                          className={`w-full p-4 flex items-center justify-between text-left hover:bg-slate-100 transition-colors cursor-pointer group ${expandedChildIndex === index ? 'bg-slate-100' : ''}`}
                        >
                          <div className="flex items-center gap-3">
                             <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${expandedChildIndex === index ? 'bg-sky-500 text-white shadow-md shadow-sky-100 scale-110' : 'bg-slate-200 text-slate-500'} transition-all`}>
                               {index + 1}
                             </div>
                             <h5 className={`font-bold transition-colors ${expandedChildIndex === index ? 'text-sky-700' : 'text-slate-600 group-hover:text-sky-600'}`}>{child.childName}</h5>
                          </div>
                          <div className="flex items-center gap-3">
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                removeChildFromShift(index);
                              }} 
                              className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                            <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform duration-300 ${expandedChildIndex === index ? 'rotate-180 text-sky-500' : ''}`} />
                          </div>
                        </div>
                        
                        <AnimatePresence>
                          {expandedChildIndex === index && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.3, ease: 'easeInOut' }}
                            >
                              <div className="p-4 pt-0 space-y-4 border-t border-slate-200/50 mt-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  <div className="md:col-span-2 space-y-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">
                                      Estado Geral
                                    </label>
                                    <textarea 
                                      value={child.generalState}
                                      onChange={(e) => updateChildShiftData(index, 'generalState', e.target.value)}
                                      className="w-full p-3 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                      rows={6}
                                    />
                                  </div>
                                  {!(child.childName.toLowerCase().includes('suzana') || child.childName.toLowerCase().includes('karina') || child.childName.toLowerCase().includes('pabline')) && (
                                    <div className="md:col-span-2 grid grid-cols-3 gap-2">
                                      <div className="space-y-1">
                                        <label className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase">SpO²</label>
                                        <input 
                                          type="text" 
                                          inputMode="numeric"
                                          value={child.spo2}
                                          onChange={(e) => updateChildShiftData(index, 'spo2', e.target.value)}
                                          className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <label className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase">FC</label>
                                        <input 
                                          type="text" 
                                          inputMode="numeric"
                                          value={child.fc}
                                          onChange={(e) => updateChildShiftData(index, 'fc', e.target.value)}
                                          className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <label className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase">TAX</label>
                                        <input 
                                          type="text" 
                                          inputMode="decimal"
                                          value={child.tax}
                                          onChange={(e) => updateChildShiftData(index, 'tax', e.target.value)}
                                          className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                        />
                                      </div>
                                    </div>
                                  )}
                                  <div className="space-y-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Diurese / Evacuação</label>
                                    <div className="grid grid-cols-2 gap-2">
                                      <input 
                                        type="text" 
                                        placeholder="Diurese"
                                        value={child.diuresis}
                                        onChange={(e) => updateChildShiftData(index, 'diuresis', e.target.value)}
                                        className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                      />
                                      <input 
                                        type="text" 
                                        placeholder="Evacuação"
                                        value={child.evacuation}
                                        onChange={(e) => updateChildShiftData(index, 'evacuation', e.target.value)}
                                        className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                      />
                                    </div>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Alimentação / Água</label>
                                    <div className="grid grid-cols-2 gap-2">
                                      <input 
                                        type="text" 
                                        placeholder="Alimentação"
                                        value={child.feeding}
                                        onChange={(e) => updateChildShiftData(index, 'feeding', e.target.value)}
                                        className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                      />
                                      <input 
                                        type="text" 
                                        placeholder="Água"
                                        value={child.water}
                                        onChange={(e) => updateChildShiftData(index, 'water', e.target.value)}
                                        className="w-full p-2.5 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                      />
                                    </div>
                                  </div>
                                  <div className="md:col-span-2 space-y-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Informações Importantes</label>
                                    <textarea 
                                      value={child.obs}
                                      onChange={(e) => updateChildShiftData(index, 'obs', e.target.value)}
                                      className="w-full p-3 bg-white rounded-xl border border-slate-100 text-sm focus:ring-2 focus:ring-sky-100 outline-none transition-all"
                                      rows={4}
                                    />
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-slate-100">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-rose-600 uppercase flex items-center gap-2">
                         <Activity className="w-4 h-4" />
                         Informações Importantes (Permanentes)
                      </label>
                      <p className="text-[9px] text-slate-500 mb-2 italic leading-tight">Avisos e orientações fixas que se repetem automaticamente em todo plantão.</p>
                      <textarea 
                        placeholder="Ex: Cuidado com acesso venoso, restrições de mobilidade, etc..."
                        value={currentShiftReport.importantInfo || ''}
                        onChange={(e) => setCurrentShiftReport({ ...currentShiftReport, importantInfo: e.target.value })}
                        className="w-full p-4 bg-rose-50/30 rounded-2xl border border-dashed border-rose-200 text-sm focus:ring-2 focus:ring-rose-200 focus:outline-none min-h-[100px] transition-all"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-sky-600 uppercase flex items-center gap-2">
                         <MessageCircle className="w-4 h-4" />
                         Informações Gerais (Relativas a Hoje)
                      </label>
                      <p className="text-[9px] text-slate-500 mb-2 italic leading-tight">Acontecimentos específicos deste plantão que mudam a cada dia.</p>
                      <textarea 
                        placeholder="Ex: Recebemos materiais novos, visita técnica realizada, etc..."
                        value={currentShiftReport.generalInfo || ''}
                        onChange={(e) => setCurrentShiftReport({ ...currentShiftReport, generalInfo: e.target.value })}
                        className="w-full p-4 bg-sky-50/30 rounded-2xl border border-dashed border-sky-200 text-sm focus:ring-2 focus:ring-sky-200 focus:outline-none min-h-[100px] transition-all"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-slate-50 flex justify-end gap-3">
                <button 
                  onClick={() => setIsShiftReportModalOpen(false)}
                  className="px-6 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-xl transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleSaveShiftReport}
                  disabled={isProcessing}
                  className="px-8 py-2 bg-sky-500 text-white font-bold rounded-xl hover:bg-sky-600 shadow-lg shadow-sky-100 transition-all flex items-center gap-2 disabled:opacity-70"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    'Salvar Relatório'
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isProfileModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsProfileModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-lg rounded-3xl shadow-2xl relative z-10 overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <h3 className="text-xl font-bold text-slate-900">{editingProfile ? 'Editar Perfil' : 'Novo Perfil'}</h3>
                <button onClick={() => setIsProfileModalOpen(false)} className="p-2 hover:bg-slate-200 rounded-full transition-all">
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Nome Completo</label>
                  <input 
                    type="text" 
                    value={profileForm.name}
                    onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                    className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                    placeholder="Ex: João Silva"
                  />
                </div>

                <div className="flex flex-col sm:grid sm:grid-cols-12 gap-4 sm:gap-3">
                  <div className="sm:col-span-4 space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Sexo</label>
                    <div className="flex gap-2">
                      <label className={`flex-1 flex items-center justify-center p-2 rounded-xl border-2 transition-all cursor-pointer ${profileForm.gender === 'M' ? 'bg-sky-50 border-sky-500' : 'bg-slate-50 border-transparent hover:bg-slate-100'}`}>
                        <input type="radio" name="gender" value="M" checked={profileForm.gender === 'M'} onChange={() => setProfileForm({ ...profileForm, gender: 'M' })} className="hidden" />
                        <Heart className={`w-5 h-5 ${profileForm.gender === 'M' ? 'fill-sky-500 text-sky-500' : 'text-slate-300'}`} />
                      </label>
                      <label className={`flex-1 flex items-center justify-center p-2 rounded-xl border-2 transition-all cursor-pointer ${profileForm.gender === 'F' ? 'bg-rose-50 border-rose-500' : 'bg-slate-50 border-transparent hover:bg-slate-100'}`}>
                        <input type="radio" name="gender" value="F" checked={profileForm.gender === 'F'} onChange={() => setProfileForm({ ...profileForm, gender: 'F' })} className="hidden" />
                        <Heart className={`w-5 h-5 ${profileForm.gender === 'F' ? 'fill-rose-500 text-rose-500' : 'text-slate-300'}`} />
                      </label>
                    </div>
                  </div>
                  <div className="sm:col-span-5 space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Data de Nasc.</label>
                    <input 
                      type="date" 
                      value={profileForm.birthDate}
                      onChange={(e) => setProfileForm({ ...profileForm, birthDate: e.target.value })}
                      className="w-full p-2 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 text-sm h-[40px]"
                    />
                  </div>
                  <div className="sm:col-span-3 space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Peso (kg)</label>
                    <input 
                      type="text" 
                      inputMode="decimal"
                      value={profileForm.weight || ''}
                      onChange={(e) => setProfileForm({ ...profileForm, weight: e.target.value })}
                      placeholder="Ex: 12.5"
                      className="w-full p-2 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 text-sm h-[40px]"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Quarto</label>
                  <select
                    value={profileForm.room || ROOM_OPTIONS[0]}
                    onChange={(e) => setProfileForm({ ...profileForm, room: e.target.value })}
                    className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                  >
                    {ROOM_OPTIONS.map(room => (
                      <option key={room} value={room}>{room}</option>
                    ))}
                    {(profileForm.room === ADMIN_ROOM) && (
                      <option value={ADMIN_ROOM}>{ADMIN_ROOM}</option>
                    )}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Dispositivos de Suporte</label>
                  <div className="flex flex-wrap gap-2">
                    {['SNE', 'GTT', 'TQT', 'Sem dispositivos'].map(device => (
                      <label key={device} className={`flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all cursor-pointer ${
                        profileForm.supportDevices?.includes(device) 
                          ? 'bg-sky-50 border-sky-500 text-sky-700' 
                          : 'bg-slate-50 border-transparent text-slate-500 hover:bg-slate-100'
                      }`}>
                        <input 
                          type="checkbox"
                          className="hidden"
                          checked={profileForm.supportDevices?.includes(device)}
                          onChange={(e) => {
                            const current = profileForm.supportDevices || [];
                            if (e.target.checked) {
                              if (device === 'Sem dispositivos') {
                                setProfileForm({ ...profileForm, supportDevices: ['Sem dispositivos'] });
                              } else {
                                setProfileForm({ ...profileForm, supportDevices: [...current.filter(d => d !== 'Sem dispositivos'), device] });
                              }
                            } else {
                              setProfileForm({ ...profileForm, supportDevices: current.filter(d => d !== device) });
                            }
                          }}
                        />
                        <span className="text-xs font-bold">{device}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* --- SEÇÃO: ROTINA ALIMENTAR --- */}
                <div className="pt-4 border-t border-slate-200 space-y-4">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <Activity className="w-5 h-5 text-emerald-500" />
                    Rotina Alimentar (Dietas)
                  </h3>

                  {/* Diet Builder */}
                  <div className="space-y-3 p-4 bg-emerald-50/50 rounded-2xl border border-emerald-100">
                    <label className="text-xs font-bold text-emerald-600 uppercase flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Horários de Alimentação / Dieta
                    </label>
                    
                    {/* List of added diets */}
                    {profileForm.dietSchedules && profileForm.dietSchedules.length > 0 && (
                      <div className="space-y-2 mb-4">
                        {profileForm.dietSchedules.map((diet) => (
                          <div key={diet.id} className="flex items-center justify-between bg-white p-3 rounded-xl border border-emerald-100">
                            <div>
                              <p className="font-bold text-slate-800 text-sm">{diet.description}</p>
                              <div className="flex gap-1 mt-1 flex-wrap">
                                {diet.times.map(t => (
                                  <span key={t} className="bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-md">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button 
                                onClick={() => {
                                  setDietDesc(diet.description);
                                  setDietTimes(diet.times);
                                  const newDiets = profileForm.dietSchedules!.filter(d => d.id !== diet.id);
                                  setProfileForm({ ...profileForm, dietSchedules: newDiets });
                                }}
                                className="p-1.5 text-sky-400 hover:bg-sky-50 rounded-lg transition-all"
                                title="Editar"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                              </button>
                              <button 
                                onClick={() => {
                                  const newDiets = profileForm.dietSchedules!.filter(d => d.id !== diet.id);
                                  setProfileForm({ ...profileForm, dietSchedules: newDiets });
                                }}
                                className="p-1.5 text-rose-400 hover:bg-rose-50 rounded-lg transition-all"
                                title="Excluir"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add new diet form */}
                    <div className="bg-white p-3 rounded-xl border border-emerald-200 space-y-3">
                      <input 
                        type="text" 
                        value={dietDesc}
                        onChange={(e) => setDietDesc(e.target.value)}
                        className="w-full p-2.5 bg-slate-50 rounded-lg border-none focus:ring-2 focus:ring-emerald-200 text-sm"
                        placeholder="Descrição da Dieta (Ex: Sonda SNE 3/3h)"
                      />
                      
                      <div className="flex gap-2">
                        <input 
                          type="time" 
                          value={dietTime}
                          onChange={(e) => setDietTime(e.target.value)}
                          className="flex-1 p-2.5 bg-slate-50 rounded-lg border-none focus:ring-2 focus:ring-emerald-200 text-sm"
                        />
                        <button 
                          onClick={() => {
                            if (dietTime && !dietTimes.includes(dietTime)) {
                              setDietTimes([...dietTimes, dietTime].sort());
                              setDietTime('');
                            }
                          }}
                          disabled={!dietTime}
                          className="px-4 bg-emerald-100 text-emerald-700 font-bold rounded-lg hover:bg-emerald-200 disabled:opacity-50 transition-all text-sm"
                        >
                          Add Horário
                        </button>
                      </div>

                      {dietTimes.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-2">
                          {dietTimes.map(t => (
                            <div key={t} className="flex items-center gap-1 bg-emerald-50 text-emerald-700 px-2 py-1 rounded-md text-xs font-bold border border-emerald-100">
                              {t}
                              <button onClick={() => setDietTimes(dietTimes.filter(time => time !== t))} className="text-emerald-400 hover:text-emerald-600">
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <button 
                        onClick={() => {
                          if (dietDesc && dietTimes.length > 0) {
                            const newDiet = {
                              id: Date.now().toString(),
                              description: dietDesc,
                              times: dietTimes
                            };
                            setProfileForm({ 
                              ...profileForm, 
                              dietSchedules: [...(profileForm.dietSchedules || []), newDiet] 
                            });
                            setDietDesc('');
                            setDietTimes([]);
                          }
                        }}
                        disabled={!dietDesc || dietTimes.length === 0}
                        className="w-full py-2 bg-emerald-500 text-white font-bold rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-all text-sm"
                      >
                        Adicionar Dieta Programada
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-400 uppercase">Observações Gerais (Dieta Líquida)</label>
                      <textarea 
                        value={profileForm.liquidDiet}
                        onChange={(e) => setProfileForm({ ...profileForm, liquidDiet: e.target.value })}
                        className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 h-20 resize-none"
                        placeholder="Fórmulas aceitas, restrições..."
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-400 uppercase">Observações Gerais (Dieta Sólida)</label>
                      <textarea 
                        value={profileForm.solidDiet}
                        onChange={(e) => setProfileForm({ ...profileForm, solidDiet: e.target.value })}
                        className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 h-20 resize-none"
                        placeholder="Aceitação de sólidos, restrições..."
                      />
                    </div>
                  </div>
                </div>

                {/* --- SEÇÃO: ROTINA DE MEDICAÇÕES --- */}
                <div className="pt-4 border-t border-slate-200 space-y-4">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <Pill className="w-5 h-5 text-amber-500" />
                    Rotina de Medicações
                  </h3>

                  {/* Recurring Medications Section */}
                  <div className="space-y-3 p-4 bg-amber-50/50 rounded-2xl border border-amber-100">
                    <label className="text-xs font-bold text-amber-600 uppercase flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Medicações Programadas
                    </label>
                    
                    {/* List of added recurring meds */}
                    {profileForm.recurringMedications && profileForm.recurringMedications.length > 0 && (
                      <div className="space-y-2 mb-4">
                        {profileForm.recurringMedications.map((med, idx) => (
                        <div key={med.id} className="flex items-center justify-between bg-white p-3 rounded-xl border border-amber-100">
                          <div>
                            <p className="font-bold text-slate-800 text-sm">{med.name}</p>
                            <div className="flex gap-1 mt-1">
                              {med.times.map((t, i) => (
                                <span key={i} className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded-md">
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button 
                              onClick={() => {
                                setRecMedName(med.name);
                                setRecMedTimes(med.times);
                                const newMeds = [...(profileForm.recurringMedications || [])];
                                newMeds.splice(idx, 1);
                                setProfileForm({ ...profileForm, recurringMedications: newMeds });
                              }}
                              className="p-1.5 text-sky-400 hover:bg-sky-50 rounded-lg transition-all"
                              title="Editar"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                            </button>
                            <button 
                              onClick={() => {
                                const newMeds = [...(profileForm.recurringMedications || [])];
                                newMeds.splice(idx, 1);
                                setProfileForm({ ...profileForm, recurringMedications: newMeds });
                              }}
                              className="p-1.5 text-rose-400 hover:bg-rose-50 rounded-lg transition-all"
                              title="Excluir"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add new recurring med form */}
                  <div className="bg-white p-3 rounded-xl border border-amber-200 space-y-3">
                    <input 
                      type="text" 
                      value={recMedName}
                      onChange={(e) => setRecMedName(e.target.value)}
                      className="w-full p-2.5 bg-slate-50 rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm"
                      placeholder="Nome da medicação (Ex: Dipirona)"
                    />
                    
                    <div>
                      <div className="flex gap-2 mb-2">
                        <input 
                          type="time" 
                          value={recMedTime}
                          onChange={(e) => setRecMedTime(e.target.value)}
                          className="flex-1 p-2.5 bg-slate-50 rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm"
                        />
                        <button 
                          onClick={() => {
                            if (recMedTime && !recMedTimes.includes(recMedTime)) {
                              setRecMedTimes([...recMedTimes, recMedTime].sort());
                              setRecMedTime('');
                            }
                          }}
                          className="px-4 bg-amber-100 text-amber-700 font-bold rounded-lg hover:bg-amber-200 transition-all text-sm"
                        >
                          Adicionar Hora
                        </button>
                      </div>
                      
                      {recMedTimes.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {recMedTimes.map((t, i) => (
                            <span key={i} className="flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-700 text-xs font-bold rounded-md border border-amber-200">
                              {t}
                              <button onClick={() => setRecMedTimes(recMedTimes.filter(time => time !== t))} className="hover:text-rose-500">
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <button 
                      onClick={() => {
                        if (recMedName && recMedTimes.length > 0) {
                          const newMed = {
                            id: Math.random().toString(36).substr(2, 9),
                            name: recMedName,
                            times: recMedTimes,
                            createdAt: new Date().toISOString()
                          };
                          setProfileForm({ 
                            ...profileForm, 
                            recurringMedications: [...(profileForm.recurringMedications || []), newMed] 
                          });
                          setRecMedName('');
                          setRecMedTimes([]);
                        }
                      }}
                      disabled={!recMedName || recMedTimes.length === 0}
                      className="w-full py-2 bg-amber-500 text-white font-bold rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-all text-sm"
                    >
                      Adicionar Medicação Programada
                    </button>
                  </div>
                </div>

                {/* Special Medications Section */}
                <div className="space-y-3 p-4 bg-purple-50/50 rounded-2xl border border-purple-100">
                  <label className="text-xs font-bold text-purple-600 uppercase flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    Rotina de Medicações de Controle Especial (Com Alerta)
                  </label>
                  
                  {/* List of added special meds */}
                  {profileForm.specialMedications && profileForm.specialMedications.length > 0 && (
                    <div className="space-y-2 mb-4">
                      {profileForm.specialMedications.map((med) => (
                        <div key={med.id} className="flex items-center justify-between bg-white p-3 rounded-xl border border-purple-100">
                          <div>
                            <p className="font-bold text-slate-800 text-sm">{med.name}</p>
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {med.times.map(t => (
                                <span key={t} className="bg-purple-100 text-purple-700 text-[10px] font-bold px-2 py-0.5 rounded-md">
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button 
                              onClick={() => {
                                setSpecMedName(med.name);
                                setSpecMedTimes(med.times);
                                const newMeds = profileForm.specialMedications!.filter(m => m.id !== med.id);
                                setProfileForm({ ...profileForm, specialMedications: newMeds });
                              }}
                              className="p-1.5 text-sky-400 hover:bg-sky-50 rounded-lg transition-all"
                              title="Editar"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                            </button>
                            <button 
                              onClick={() => {
                                const newMeds = profileForm.specialMedications!.filter(m => m.id !== med.id);
                                setProfileForm({ ...profileForm, specialMedications: newMeds });
                              }}
                              className="p-1.5 text-rose-400 hover:bg-rose-50 rounded-lg transition-all"
                              title="Excluir"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add new special med form */}
                  <div className="bg-white p-3 rounded-xl border border-purple-200 space-y-3">
                    <input 
                      type="text" 
                      value={specMedName}
                      onChange={(e) => setSpecMedName(e.target.value)}
                      className="w-full p-2.5 bg-slate-50 rounded-lg border-none focus:ring-2 focus:ring-purple-200 text-sm"
                      placeholder="Nome da medicação especial"
                    />
                    
                    <div className="flex gap-2">
                      <input 
                        type="time" 
                        value={specMedTime}
                        onChange={(e) => setSpecMedTime(e.target.value)}
                        className="flex-1 p-2.5 bg-slate-50 rounded-lg border-none focus:ring-2 focus:ring-purple-200 text-sm"
                      />
                      <button 
                        onClick={() => {
                          if (specMedTime && !specMedTimes.includes(specMedTime)) {
                            setSpecMedTimes([...specMedTimes, specMedTime].sort());
                            setSpecMedTime('');
                          }
                        }}
                        disabled={!specMedTime}
                        className="px-4 bg-purple-100 text-purple-700 font-bold rounded-lg hover:bg-purple-200 disabled:opacity-50 transition-all text-sm"
                      >
                        Add Horário
                      </button>
                    </div>

                    {specMedTimes.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-2">
                        {specMedTimes.map(t => (
                          <div key={t} className="flex items-center gap-1 bg-purple-50 text-purple-700 px-2 py-1 rounded-md text-xs font-bold border border-purple-100">
                            {t}
                            <button onClick={() => setSpecMedTimes(specMedTimes.filter(time => time !== t))} className="text-purple-400 hover:text-purple-600">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <button 
                      onClick={() => {
                        if (specMedName && specMedTimes.length > 0) {
                          const newMed = {
                            id: Math.random().toString(36).substr(2, 9),
                            name: specMedName,
                            times: specMedTimes,
                            createdAt: new Date().toISOString()
                          };
                          setProfileForm({ 
                            ...profileForm, 
                            specialMedications: [...(profileForm.specialMedications || []), newMed] 
                          });
                          setSpecMedName('');
                          setSpecMedTimes([]);
                        }
                      }}
                      disabled={!specMedName || specMedTimes.length === 0}
                      className="w-full py-2 bg-purple-500 text-white font-bold rounded-lg hover:bg-purple-600 disabled:opacity-50 transition-all text-sm"
                    >
                      Adicionar Medicação de Controle Especial
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Medicações SOS</label>
                    <textarea 
                      value={profileForm.sosMedications}
                      onChange={(e) => setProfileForm({ ...profileForm, sosMedications: e.target.value })}
                      className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 resize-none"
                      placeholder="Ex: Dipirona se febre"
                      rows={4}
                    />
                  </div>
                  <div className="space-y-4 p-4 bg-amber-50 rounded-2xl border border-amber-100">
                    <div className="flex items-center gap-2 text-amber-700 font-bold text-sm">
                      <Calendar className="w-4 h-4" /> Medicações Temporárias (Inteligente)
                    </div>
                    
                    <div className="grid grid-cols-1 gap-3">
                      <input 
                        type="text" 
                        placeholder="Nome da medicação (Ex: Dipirona)"
                        value={tempMedName}
                        onChange={(e) => setTempMedName(e.target.value)}
                        className="w-full p-2.5 bg-white rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm shadow-sm"
                      />
                      
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-amber-600 uppercase">Horários de Administração</label>
                        <div className="flex gap-2">
                          <input 
                            type="time" 
                            value={tempMedTime}
                            onChange={(e) => setTempMedTime(e.target.value)}
                            className="flex-1 p-2.5 bg-white rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm shadow-sm"
                          />
                          <button 
                            type="button"
                            onClick={() => {
                              if (tempMedTime && !tempMedTimes.includes(tempMedTime)) {
                                setTempMedTimes([...tempMedTimes, tempMedTime].sort());
                                setTempMedTime('');
                              }
                            }}
                            disabled={!tempMedTime}
                            className="px-4 bg-amber-100 text-amber-700 font-bold rounded-lg hover:bg-amber-200 disabled:opacity-50 transition-all text-sm"
                          >
                            Adicionar Hora
                          </button>
                        </div>
                        {tempMedTimes.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {tempMedTimes.map(t => (
                              <div key={t} className="flex items-center gap-1 bg-white text-amber-700 px-2 py-1 rounded-md text-[10px] font-bold border border-amber-100">
                                {t}
                                <button type="button" onClick={() => setTempMedTimes(tempMedTimes.filter(time => time !== t))} className="text-amber-300 hover:text-amber-500">
                                  <X className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-amber-600 uppercase">Início</label>
                          <input 
                            type="date" 
                            value={tempMedStartDate}
                            onChange={(e) => setTempMedStartDate(e.target.value)}
                            className="w-full p-2.5 bg-white rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm shadow-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-amber-600 uppercase">Término</label>
                          <input 
                            type="date" 
                            value={tempMedEndDate}
                            onChange={(e) => setTempMedEndDate(e.target.value)}
                            className="w-full p-2.5 bg-white rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm shadow-sm"
                          />
                        </div>
                      </div>
                      
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-amber-600 uppercase">Expira em (Horário)</label>
                        <input 
                          type="time" 
                          value={tempMedEndTime}
                          onChange={(e) => setTempMedEndTime(e.target.value)}
                          className="w-full p-2.5 bg-white rounded-lg border-none focus:ring-2 focus:ring-amber-200 text-sm shadow-sm"
                        />
                      </div>

                      <button 
                        type="button"
                        onClick={() => {
                          if (tempMedName && tempMedStartDate && tempMedEndDate && tempMedEndTime) {
                            const newTempMed: TemporaryMedication = {
                              id: Math.random().toString(36).substr(2, 9),
                              description: tempMedName,
                              startDate: tempMedStartDate,
                              endDate: tempMedEndDate,
                              endTime: tempMedEndTime,
                              times: tempMedTimes
                            };
                            setProfileForm({ 
                              ...profileForm, 
                              temporaryMedications: [...(profileForm.temporaryMedications || []), newTempMed] 
                            });
                            setTempMedName('');
                            setTempMedStartDate('');
                            setTempMedEndDate('');
                            setTempMedEndTime('');
                            setTempMedTimes([]);
                          }
                        }}
                        disabled={!tempMedName || !tempMedStartDate || !tempMedEndDate || !tempMedEndTime}
                        className="w-full py-2.5 bg-amber-500 text-white font-bold rounded-xl hover:bg-amber-600 disabled:opacity-50 transition-all text-sm shadow-md"
                      >
                        Adicionar Medicação Temporária
                      </button>
                    </div>

                    {profileForm.temporaryMedications && profileForm.temporaryMedications.length > 0 && (
                      <div className="space-y-2 pt-2 border-t border-amber-200">
                        {profileForm.temporaryMedications.map(tm => (
                          <div key={tm.id} className="flex items-center justify-between bg-white p-3 rounded-xl border border-amber-100 shadow-sm">
                            <div className="flex flex-col">
                              <span className="text-xs font-bold text-amber-900">{tm.description}</span>
                              <span className="text-[10px] text-amber-600">
                                {tm.times && tm.times.length > 0 && `Horários: ${tm.times.join(', ')} | `}
                                {new Date(tm.startDate + 'T00:00:00').toLocaleDateString('pt-BR')} até {new Date(tm.endDate + 'T00:00:00').toLocaleDateString('pt-BR')} às {tm.endTime}
                              </span>
                            </div>
                            <button 
                              type="button"
                              onClick={() => setProfileForm({
                                ...profileForm,
                                temporaryMedications: profileForm.temporaryMedications?.filter(item => item.id !== tm.id)
                              })}
                              className="text-amber-300 hover:text-rose-500 transition-colors"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* --- SEÇÃO: OUTRAS INFORMAÇÕES --- */}
              <div className="pt-4 border-t border-slate-200 space-y-4">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  <Heart className="w-5 h-5 text-rose-500" />
                  Outras Informações
                </h3>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Principais patologias clínicas</label>
                  <textarea 
                    value={profileForm.preferences}
                    onChange={(e) => setProfileForm({ ...profileForm, preferences: e.target.value })}
                    className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 h-20 resize-none"
                    placeholder="Descreva as principais patologias clínicas da criança..."
                  />
                </div>
              </div>
            </div>
            <div className="p-6 bg-slate-50 flex justify-end gap-3">
              <button 
                onClick={() => setIsProfileModalOpen(false)}
                  className="px-6 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-xl transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleSaveProfile}
                  disabled={isProcessing}
                  className="px-8 py-2 bg-sky-500 text-white font-bold rounded-xl hover:bg-sky-600 shadow-lg shadow-sky-100 transition-all flex items-center gap-2 disabled:opacity-70"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    'Salvar Perfil'
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Notification Modal */}
      <AnimatePresence>
        {isNotificationModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsNotificationModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-md rounded-3xl shadow-2xl relative z-10 overflow-hidden max-h-[90vh] flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
                <h3 className="text-xl font-bold text-slate-900">Agendar Aviso</h3>
                <button onClick={() => setIsNotificationModalOpen(false)} className="p-2 hover:bg-slate-200 rounded-full transition-all">
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>
              <div className="p-6 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Título do Aviso</label>
                  <input 
                    type="text" 
                    value={notificationForm.title}
                    onChange={(e) => setNotificationForm({ ...notificationForm, title: e.target.value })}
                    className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                    placeholder="Ex: Consulta Pediátrica"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Descrição</label>
                  <textarea 
                    value={notificationForm.description}
                    onChange={(e) => setNotificationForm({ ...notificationForm, description: e.target.value })}
                    className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200 h-20 resize-none"
                    placeholder="Detalhes sobre o lembrete..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Data de Início</label>
                    <input 
                      type="date" 
                      value={notificationForm.startDate || notificationForm.date}
                      onChange={(e) => setNotificationForm({ ...notificationForm, startDate: e.target.value, date: e.target.value })}
                      className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Data de Fim</label>
                    <input 
                      type="date" 
                      value={notificationForm.endDate || notificationForm.date}
                      onChange={(e) => setNotificationForm({ ...notificationForm, endDate: e.target.value })}
                      className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Hora</label>
                    <input 
                      type="time" 
                      value={notificationForm.time}
                      onChange={(e) => setNotificationForm({ ...notificationForm, time: e.target.value })}
                      className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Tipo de Aviso</label>
                  <select 
                    value={notificationForm.type}
                    onChange={(e) => setNotificationForm({ ...notificationForm, type: e.target.value as any })}
                    className="w-full p-3 bg-slate-50 rounded-xl border-none focus:ring-2 focus:ring-sky-200"
                  >
                    <option value="other">Outro</option>
                    <option value="medical">Médico</option>
                    {medicationNotificationsEnabled && <option value="medication_checkout">Medicação (Controle Especial)</option>}
                    <option value="report">Relatório</option>
                    <option value="activity">Atividade</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Anexo (Imagem)</label>
                  <div className="flex items-center gap-3">
                    <label className="cursor-pointer bg-slate-50 border-2 border-dashed border-slate-200 hover:border-sky-300 hover:bg-sky-50 transition-all rounded-xl p-4 flex flex-col items-center gap-2 w-full">
                      <input 
                        type="file" 
                        accept="image/*" 
                        onChange={handleNotificationImageUpload} 
                        className="hidden" 
                      />
                      {notificationForm.imageUrl ? (
                        <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-slate-100">
                          <img src={notificationForm.imageUrl} alt="Preview" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                            <span className="text-[10px] font-bold text-white uppercase bg-black/40 px-2 py-1 rounded-lg">Trocar Imagem</span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <ImageIcon className="w-6 h-6 text-slate-400" />
                          <div className="text-center">
                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Clique para anexar</p>
                            <p className="text-[9px] text-slate-400 font-medium">Fotos de documentos ou solicitações</p>
                          </div>
                        </>
                      )}
                    </label>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-slate-50 flex justify-end gap-3 shrink-0">
                <button 
                  onClick={() => setIsNotificationModalOpen(false)}
                  className="px-6 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-xl transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleSaveNotification}
                  className="px-8 py-2 bg-sky-500 text-white font-bold rounded-xl hover:bg-sky-600 shadow-lg shadow-sky-100 transition-all"
                >
                  Agendar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Medical Event Modal */}
      <AnimatePresence>
        {isMedicalEventModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMedicalEventModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className={`p-8 border-b flex items-center justify-between shrink-0 ${
                medicalEventForm.type === 'medical_request' ? 'bg-indigo-50 border-indigo-100' : 'bg-emerald-50 border-emerald-100'
              }`}>
                <div>
                  <h3 className={`text-xl font-bold ${
                    medicalEventForm.type === 'medical_request' ? 'text-indigo-900' : 'text-emerald-900'
                  }`}>
                    {medicalEventForm.id ? 'Editar' : 'Nova'} {medicalEventForm.type === 'medical_request' ? 'Solicitação Médica' : 'Registro de Evento'}
                  </h3>
                  <p className={`text-xs font-medium ${
                    medicalEventForm.type === 'medical_request' ? 'text-indigo-600' : 'text-emerald-600'
                  }`}>
                    {medicalEventForm.type === 'medical_request' ? 'Agende consultas ou exames' : 'Confirme a realização de procedimentos'}
                  </p>
                </div>
                <button onClick={() => setIsMedicalEventModalOpen(false)} className="p-2 hover:bg-white/50 rounded-full transition-all">
                  <X className="w-6 h-6 text-slate-500" />
                </button>
              </div>

              <div className="p-8 space-y-5 overflow-y-auto flex-1 custom-scrollbar">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Criança / Paciente</label>
                  <select 
                    value={medicalEventForm.childId}
                    onChange={(e) => setMedicalEventForm({ ...medicalEventForm, childId: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-sm font-medium"
                  >
                    <option value="">{profiles.length === 0 ? 'Carregando crianças...' : 'Selecione a criança...'}</option>
                    {profiles
                      .filter(p => !myActiveRoom || myActiveRoom === ADMIN_ROOM || (myActiveRoom === 'Internação Temporária' ? p.id === internedChildId : p.room === myActiveRoom))
                      .map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Data do Evento</label>
                    <div className="relative">
                      <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input 
                        type="date" 
                        value={medicalEventForm.date}
                        onChange={(e) => setMedicalEventForm({ ...medicalEventForm, date: e.target.value })}
                        className="w-full p-4 pl-12 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-sm font-medium"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Hora</label>
                    <div className="relative">
                      <Clock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input 
                        type="time" 
                        value={medicalEventForm.time}
                        onChange={(e) => setMedicalEventForm({ ...medicalEventForm, time: e.target.value })}
                        className="w-full p-4 pl-12 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 text-sm font-medium"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Descrição / Detalhes</label>
                  <textarea 
                    value={medicalEventForm.description}
                    onChange={(e) => setMedicalEventForm({ ...medicalEventForm, description: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-sky-200 h-32 resize-none text-sm font-medium"
                    placeholder="Ex: Consulta com Dr. Paulo às 15h..."
                  />
                </div>
              </div>
              <div className="p-8 bg-slate-50 flex flex-col sm:flex-row gap-3 shrink-0">
                {medicalEventForm.id && (
                  <button 
                    onClick={() => {
                      setDeleteEventPassword('');
                      setDeleteEventPasswordError(false);
                      setIsDeleteEventConfirmOpen(true);
                    }}
                    className="w-full py-4 bg-rose-50 text-rose-600 font-bold rounded-2xl hover:bg-rose-100 transition-all border border-rose-100"
                  >
                    Excluir
                  </button>
                )}
                <button 
                  onClick={() => setIsMedicalEventModalOpen(false)}
                  className="w-full py-4 bg-slate-100 text-slate-600 font-bold rounded-2xl hover:bg-slate-200 transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleConfirmMedicalEvent}
                  disabled={!medicalEventForm.childId || !medicalEventForm.description}
                  className={`w-full py-4 text-white font-bold rounded-2xl shadow-lg transition-all disabled:opacity-50 ${
                    medicalEventForm.type === 'medical_request' ? 'bg-indigo-500 hover:bg-indigo-600 shadow-indigo-100' : 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-100'
                  }`}
                >
                  {medicalEventForm.id ? 'Salvar Alterações' : 'Confirmar Registro'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Medical Report AI Modal */}
      <AnimatePresence>
        {isReportAIModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsReportAIModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 bg-sky-50 border-b border-sky-100 flex items-center justify-between shrink-0">
                <div>
                  <h3 className="text-xl font-bold text-sky-900">Processar Relatório Médico (AI)</h3>
                  <p className="text-xs font-medium text-sky-600">Extraia dados de exames e consultas automaticamente</p>
                </div>
                <button onClick={() => setIsReportAIModalOpen(false)} className="p-2 hover:bg-sky-200 rounded-full transition-all">
                  <X className="w-6 h-6 text-sky-600" />
                </button>
              </div>

              <div className="p-8 space-y-6 overflow-y-auto flex-1 custom-scrollbar">
                {!reportAIPreview ? (
                  <div className="space-y-6">
                    <div className="border-2 border-dashed border-sky-200 rounded-3xl p-12 text-center space-y-4 bg-sky-50/30 relative">
                      <div className="w-16 h-16 bg-sky-100 text-sky-500 rounded-2xl flex items-center justify-center mx-auto">
                        <Upload className="w-8 h-8" />
                      </div>
                      <div>
                        <p className="font-bold text-slate-700">Upload do Relatório</p>
                        <p className="text-xs text-slate-500">Arraste ou clique para selecionar uma ou mais imagens do relatório</p>
                      </div>
                      <input 
                        type="file" 
                        accept="image/*"
                        multiple
                        onChange={handleReportAIUpload}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        disabled={isReportAIProcessing}
                      />
                    </div>
                    
                    {reportAIImages.length > 0 && !reportAIPreview && (
                      <div className="grid grid-cols-3 gap-2 mt-4">
                        {reportAIImages.map((img, idx) => (
                          <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-slate-200">
                            <img src={`data:${img.mimeType};base64,${img.base64}`} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
                            <div className="absolute top-1 right-1 bg-black/50 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold">
                              {idx + 1}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {isReportAIProcessing && (
                      <div className="flex items-center justify-center gap-3 text-sky-600 font-bold animate-pulse">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>Analisando relatório com IA...</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                          <label className="text-[10px] font-bold text-slate-400 uppercase">Paciente Identificado</label>
                          <p className="font-bold text-slate-900">{reportAIPreview.patientName}</p>
                          
                          <div className="mt-4 space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase">Vincular ao Perfil</label>
                            <select 
                              value={matchedReportProfileId || ''}
                              onChange={(e) => setMatchedReportProfileId(e.target.value)}
                              className="w-full p-3 bg-white rounded-xl border border-slate-200 text-sm font-medium"
                            >
                              <option value="">{profiles.length === 0 ? 'Carregando opções...' : 'Selecione o perfil...'}</option>
                              {profiles
                                .filter(p => !myActiveRoom || myActiveRoom === ADMIN_ROOM || (myActiveRoom === 'Internação Temporária' ? p.id === internedChildId : p.room === myActiveRoom))
                                .map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            {!matchedReportProfileId && (
                              <p className="text-[10px] text-rose-500 font-bold italic">* Selecione um perfil para salvar os dados</p>
                            )}
                          </div>
                        </div>

                        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                          <label className="text-[10px] font-bold text-slate-400 uppercase">Tipo & Data</label>
                          <p className="text-sm font-bold text-slate-900">{reportAIPreview.reportType}</p>
                          <p className="text-xs text-slate-500">{formatDateBR(reportAIPreview.date)}</p>
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                          <label className="text-[10px] font-bold text-emerald-600 uppercase">Principais Achados</label>
                          <p className="text-sm text-emerald-900 mt-1">{reportAIPreview.findings}</p>
                        </div>
                        <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                          <label className="text-[10px] font-bold text-indigo-600 uppercase">Recomendações</label>
                          <ul className="mt-2 space-y-1">
                            {reportAIPreview.recommendations.map((rec, i) => (
                              <li key={i} className="text-xs text-indigo-900 flex items-start gap-2">
                                <CheckCircle2 className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                {rec}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {reportAIPreview && (
                <div className="p-8 bg-slate-50 flex flex-col sm:flex-row gap-3 shrink-0">
                  <button 
                    onClick={() => {
                      setReportAIPreview(null);
                      setReportAIImages([]);
                    }}
                    className="w-full py-4 bg-slate-100 text-slate-600 font-bold rounded-2xl hover:bg-slate-200 transition-all"
                  >
                    Tentar Novamente
                  </button>
                  <button 
                    onClick={handleConfirmReportAI}
                    disabled={!matchedReportProfileId}
                    className="w-full py-4 bg-sky-500 text-white font-bold rounded-2xl hover:bg-sky-600 shadow-lg shadow-sky-100 disabled:opacity-50 transition-all"
                  >
                    Confirmar e Salvar no Prontuário
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Thinking Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/10 backdrop-blur-sm z-[60] flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white p-8 rounded-3xl shadow-2xl text-center space-y-4 max-w-xs w-full"
            >
              <div className="relative w-20 h-20 mx-auto">
                <motion.div 
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="absolute inset-0 border-4 border-sky-100 border-t-sky-500 rounded-full"
                />
                <div className="absolute inset-0 flex items-center justify-center -space-x-2.5">
                  <Heart className="w-5 h-5 text-sky-500 fill-sky-500 animate-pulse rotate-45 z-10 relative translate-y-0.5" />
                  <Heart className="w-5 h-5 text-rose-500 fill-rose-500 animate-pulse relative" />
                </div>
              </div>
              <div>
                <h3 className="font-bold text-slate-900">Analisando Dados...</h3>
                <p className="text-sm text-slate-500">Organizando informações para o seu relatório.</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Report Detail Modal */}
      <AnimatePresence>
        {selectedReport && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Visualizar Relatório</h2>
                  <p className="text-sm text-slate-500">{formatDateBR(selectedReport.date)} - {selectedReport.room}</p>
                </div>
                <button 
                  onClick={() => setSelectedReport(null)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-6 h-6 text-slate-400" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                <div className="bg-slate-50 rounded-3xl p-6 border border-slate-100">
                  <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 leading-relaxed">
                    {formatShiftReportForWhatsApp(selectedReport)}
                  </pre>
                </div>

                <div className="space-y-6">
                  <h3 className="font-bold text-slate-900 flex items-center gap-2">
                    <Users className="w-5 h-5 text-sky-500" /> Detalhes por Criança
                  </h3>
                  
                  <div className="grid gap-4">
                    {selectedReport.childrenData.map((child, idx) => (
                      <div key={idx} className="border border-slate-100 rounded-2xl p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <h4 className="font-bold text-sky-600">{child.childName}</h4>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                          <div className="md:col-span-2 space-y-1">
                            <span className="text-slate-400 font-medium block">Estado Geral</span>
                            <p className="text-slate-700">{child.generalState}</p>
                          </div>
                          
                          {!(child.childName.toLowerCase().includes('suzana') || child.childName.toLowerCase().includes('karina') || child.childName.toLowerCase().includes('pabline')) && (
                            <div className="md:col-span-2 grid grid-cols-3 gap-2">
                              <div className="bg-slate-50 p-2 rounded-xl text-center">
                                <span className="text-[10px] text-slate-400 font-bold block uppercase">SpO²</span>
                                <span className="text-slate-700 font-bold">{formatVital(child.spo2, '%')}</span>
                              </div>
                              <div className="bg-slate-50 p-2 rounded-xl text-center">
                                <span className="text-[10px] text-slate-400 font-bold block uppercase">FC</span>
                                <span className="text-slate-700 font-bold">{formatVital(child.fc, 'BPM')}</span>
                              </div>
                              <div className="bg-slate-50 p-2 rounded-xl text-center">
                                <span className="text-[10px] text-slate-400 font-bold block uppercase">TAX</span>
                                <span className="text-slate-700 font-bold">{formatVital(child.tax, '°C')}</span>
                              </div>
                            </div>
                          )}

                          <div className="space-y-1">
                            <span className="text-slate-400 font-medium block">Diurese / Evacuação</span>
                            <p className="text-slate-700">{child.diuresis} / {child.evacuation}</p>
                          </div>

                          {(child.feeding || child.water) && (
                            <div className="space-y-1">
                              <span className="text-slate-400 font-medium block">Dieta / Água</span>
                              <p className="text-slate-700">
                                {child.feeding && `Dieta: ${child.feeding}`}
                                {child.feeding && child.water && ' | '}
                                {child.water && `Água: ${child.water}`}
                              </p>
                            </div>
                          )}
                        </div>

                        {child.obs && (
                          <div className="bg-rose-50/50 p-3 rounded-xl border border-rose-100/50">
                            <span className="text-[10px] text-rose-600 font-bold block uppercase mb-1">Informações Importantes</span>
                            <p className="text-sm text-slate-700 font-medium">{child.obs}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => {
                    const text = formatShiftReportForWhatsApp(selectedReport);
                    copyToClipboard(text);
                  }}
                  className="flex-1 bg-emerald-500 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-200"
                >
                  <ClipboardList className="w-5 h-5" /> Copiar para WhatsApp
                </button>
                <button 
                  onClick={() => setSelectedReport(null)}
                  className="px-8 bg-white border border-slate-200 text-slate-600 py-4 rounded-2xl font-bold hover:bg-slate-50 transition-all"
                >
                  Fechar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Activity Detail Modal */}
      <AnimatePresence>
        {selectedActivity && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-lg rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${
                    selectedActivity.type === 'medication' ? 'bg-amber-100 text-amber-600' :
                    selectedActivity.type === 'incident' ? 'bg-rose-100 text-rose-600' :
                    selectedActivity.type === 'activity' ? 'bg-emerald-100 text-emerald-600' :
                    selectedActivity.type === 'medical_request' ? 'bg-indigo-100 text-indigo-600' :
                    selectedActivity.type === 'medical_completed' ? 'bg-emerald-100 text-emerald-600' :
                    'bg-sky-100 text-sky-600'
                  }`}>
                    {selectedActivity.type === 'medication' && <Pill className="w-6 h-6" />}
                    {selectedActivity.type === 'incident' && <AlertCircle className="w-6 h-6" />}
                    {selectedActivity.type === 'activity' && <Activity className="w-6 h-6" />}
                    {selectedActivity.type === 'report' && <FileText className="w-6 h-6" />}
                    {selectedActivity.type === 'medical_request' && <Stethoscope className="w-6 h-6" />}
                    {selectedActivity.type === 'medical_completed' && <CalendarCheck className="w-6 h-6" />}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Detalhes do Registro</h3>
                    <p className="text-sm text-slate-500">{selectedActivity.childName}</p>
                  </div>
                </div>
                <button onClick={() => setSelectedActivity(null)} className="p-2 hover:bg-slate-200 rounded-full transition-all">
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>
              
              <div className="p-6 overflow-y-auto space-y-6">
                <div className="flex flex-wrap gap-3">
                  <div className="bg-slate-50 px-4 py-2 rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block mb-0.5">Data e Hora</span>
                    <span className="text-sm font-bold text-slate-700">
                      {new Date(selectedActivity.timestamp).toLocaleString('pt-BR')}
                    </span>
                  </div>
                  <div className="bg-slate-50 px-4 py-2 rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block mb-0.5">Status</span>
                    <span className={`text-sm font-bold ${selectedActivity.status === 'urgent' ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {selectedActivity.status === 'urgent' ? 'Urgente' : 'Concluído'}
                    </span>
                  </div>
                  {selectedActivity.appointmentDate && (
                    <div className="bg-slate-50 px-4 py-2 rounded-xl border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase block mb-0.5">Data Agendada</span>
                      <span className="text-sm font-bold text-slate-700">
                        {formatDateBR(selectedActivity.appointmentDate)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-400 uppercase">Descrição Completa</h4>
                    <div className="flex gap-2">
                      {!isEditingActivity ? (
                        <>
                          <button 
                            onClick={() => setIsEditingActivity(true)}
                            className="p-2 bg-sky-50 text-sky-600 rounded-lg hover:bg-sky-100 transition-all flex items-center gap-1 text-[10px] font-bold uppercase"
                          >
                            <Edit3 className="w-3.5 h-3.5" /> Editar
                          </button>
                          <button 
                            onClick={() => handleDeleteActivity(selectedActivity.id)}
                            className="p-2 bg-rose-50 text-rose-600 rounded-lg hover:bg-rose-100 transition-all flex items-center gap-1 text-[10px] font-bold uppercase"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Excluir
                          </button>
                        </>
                      ) : (
                        <button 
                          onClick={() => setIsEditingActivity(false)}
                          className="p-2 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-all text-[10px] font-bold uppercase"
                        >
                          Cancelar
                        </button>
                      )}
                    </div>
                  </div>
                  
                  {isEditingActivity ? (
                    <div className="space-y-3">
                      <textarea
                        value={editActivityText}
                        onChange={(e) => setEditActivityText(e.target.value)}
                        className="w-full p-4 bg-slate-50 rounded-2xl border-2 border-sky-100 focus:border-sky-400 focus:ring-4 focus:ring-sky-50 outline-none transition-all text-slate-700 min-h-[150px]"
                        placeholder="Edite a descrição aqui..."
                      />
                      <button
                        onClick={handleUpdateActivity}
                        className="w-full py-3 bg-sky-500 text-white rounded-xl font-bold hover:bg-sky-600 shadow-lg shadow-sky-100 transition-all flex items-center justify-center gap-2"
                      >
                        <Save className="w-4 h-4" /> Salvar Alterações
                      </button>
                    </div>
                  ) : (
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                      <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">
                        {selectedActivity.description}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 border-t border-slate-100 bg-slate-50/50 shrink-0">
                <button 
                  onClick={() => setSelectedActivity(null)}
                  className="w-full py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all"
                >
                  Fechar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Activity Delete Confirmation Modal */}
      <AnimatePresence>
        {activityToDelete && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto">
                  <Trash2 className="w-8 h-8 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">Excluir Registro?</h3>
                  <p className="text-sm text-slate-500">
                    Tem certeza que deseja excluir este registro? Esta ação não pode ser desfeita.
                  </p>
                </div>
              </div>
              <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => setActivityToDelete(null)}
                  className="flex-1 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all cursor-pointer"
                >
                  Cancelar
                </button>
                <button 
                  onClick={confirmDeleteActivity}
                  className="flex-1 py-3 bg-rose-500 text-white rounded-xl font-bold hover:bg-rose-600 shadow-lg shadow-rose-200 transition-all cursor-pointer"
                >
                  Excluir
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Shift Report Delete Confirmation Modal */}
      <AnimatePresence>
        {reportToDelete && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto">
                  <Trash2 className="w-8 h-8 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">Excluir Relatório?</h3>
                  <p className="text-sm text-slate-500">
                    Tem certeza que deseja excluir este relatório de plantão? Esta ação não pode ser desfeita.
                  </p>
                </div>
              </div>
              <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => setReportToDelete(null)}
                  className="flex-1 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={async () => {
                    try {
                      if (user) {
                        await deleteDoc(doc(db, 'shiftReports', reportToDelete.id));
                      } else {
                        setShiftReports(shiftReports.filter(r => r.id !== reportToDelete.id));
                      }
                      setReportToDelete(null);
                    } catch (error) {
                      handleFirestoreError(error, OperationType.DELETE, `shiftReports/${reportToDelete.id}`);
                    }
                  }}
                  className="flex-1 py-3 bg-rose-500 text-white rounded-xl font-bold hover:bg-rose-600 shadow-lg shadow-rose-200 transition-all"
                >
                  Excluir
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Logout Confirmation Modal */}
      <AnimatePresence>
        {isLogoutModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto">
                  <AlertCircle className="w-8 h-8 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">Sair da conta?</h3>
                  <p className="text-sm text-slate-500">
                    Tem certeza que deseja sair? Você precisará fazer login novamente para acessar seus dados na nuvem.
                  </p>
                </div>
              </div>
              <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => {
                      setMyActiveRoom('');
                      setIsLogoutModalOpen(false);
                    }}
                    className="py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all text-xs"
                  >
                    Trocar de Quarto
                  </button>
                  {myActiveRoom !== ADMIN_ROOM && (
                    <button 
                      onClick={() => {
                        setIsLogoutModalOpen(false);
                        setRoomToAccess(ADMIN_ROOM);
                        setIsPasswordModalOpen(true);
                      }}
                      className="py-3 bg-indigo-50 border border-indigo-100 text-indigo-600 rounded-xl font-bold hover:bg-indigo-100 transition-all text-xs"
                    >
                      Posto de Enfermagem
                    </button>
                  )}
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsLogoutModalOpen(false)}
                    className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 transition-all"
                  >
                    Voltar
                  </button>
                  <button 
                    onClick={() => {
                      auth.signOut();
                      setMyActiveRoom('');
                      setIsLogoutModalOpen(false);
                    }}
                    className="flex-1 py-3 bg-rose-500 text-white rounded-xl font-bold hover:bg-rose-600 shadow-lg shadow-rose-200 transition-all"
                  >
                    Sair
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Admin Room Password Access Modal */}
      <AnimatePresence>
        {isPasswordModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-8 text-center space-y-4">
                <div className="w-20 h-20 bg-indigo-50 rounded-[2rem] flex items-center justify-center mx-auto">
                  <Clock className="w-10 h-10 text-indigo-500" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-slate-900 mb-2">Acesso Restrito</h3>
                  <p className="text-slate-500 font-medium text-sm">
                    Digite a senha de acesso para o <strong>{ADMIN_ROOM}</strong>.
                  </p>
                </div>
              </div>
              <div className="px-8 pb-4">
                <input 
                  type="password"
                  value={enteredPassword}
                  onChange={(e) => {
                    setEnteredPassword(e.target.value);
                    setPasswordError(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && enteredPassword) {
                      if (enteredPassword === adminPassword) {
                        setMyActiveRoom(ADMIN_ROOM);
                        setIsPasswordModalOpen(false);
                        setEnteredPassword('');
                      } else {
                        setPasswordError(true);
                      }
                    }
                  }}
                  className={`w-full p-4 bg-slate-50 rounded-2xl border-2 transition-all text-center text-lg tracking-widest font-bold focus:ring-0 ${
                    passwordError ? 'border-rose-300 text-rose-500' : 'border-transparent focus:border-indigo-400'
                  }`}
                  placeholder="••••••••"
                  autoFocus
                />
                {passwordError && (
                  <p className="text-center text-rose-500 text-xs font-bold mt-2 animate-bounce">Senha incorreta. Tente novamente.</p>
                )}
              </div>
              <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => {
                    setIsPasswordModalOpen(false);
                    setEnteredPassword('');
                    setPasswordError(false);
                  }}
                  className="flex-1 py-4 bg-white border border-slate-200 text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={() => {
                    if (enteredPassword === adminPassword) {
                      setMyActiveRoom(ADMIN_ROOM);
                      setIsPasswordModalOpen(false);
                      setEnteredPassword('');
                    } else {
                      setPasswordError(true);
                    }
                  }}
                  disabled={!enteredPassword}
                  className="flex-1 py-4 bg-indigo-500 text-white font-bold rounded-2xl hover:bg-indigo-600 shadow-lg shadow-indigo-200 transition-all disabled:opacity-50"
                >
                  Acessar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {profileToDelete && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto">
                  <Trash2 className="w-8 h-8 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">Excluir Perfil?</h3>
                  <p className="text-sm text-slate-500">
                    Tem certeza que deseja excluir o perfil de <strong>{profileToDelete.name}</strong>? Esta ação não pode ser desfeita.
                  </p>
                </div>
              </div>
              <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => setProfileToDelete(null)}
                  className="flex-1 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={async () => {
                    try {
                      if (user) {
                        await deleteDoc(doc(db, 'profiles', profileToDelete.id));
                      } else {
                        setProfiles(profiles.filter(p => p.id !== profileToDelete.id));
                      }
                      setProfileToDelete(null);
                    } catch (error) {
                      handleFirestoreError(error, OperationType.DELETE, `profiles/${profileToDelete.id}`);
                    }
                  }}
                  className="flex-1 py-3 bg-rose-500 text-white rounded-xl font-bold hover:bg-rose-600 shadow-lg shadow-rose-200 transition-all"
                >
                  Excluir
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Medical Event Delete Confirmation Modal */}
      <AnimatePresence>
        {isDeleteEventConfirmOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-8 text-center space-y-4">
                <div className="w-20 h-20 bg-rose-50 rounded-[2rem] flex items-center justify-center mx-auto ring-8 ring-rose-50/50">
                  <Trash2 className="w-10 h-10 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-slate-900 mb-2">Excluir Registro?</h3>
                  <p className="text-slate-500 font-medium text-sm">
                    Você tem certeza que deseja excluir este registro de <strong>"{profiles.find(p => p.id === medicalEventForm.childId)?.name || 'Evento'}"</strong>?
                  </p>
                  <p className="mt-2 text-xs text-slate-400 italic">Esta ação não pode ser desfeita.</p>
                </div>

                {medicalEventForm.type === 'medical_request' && (
                  <div className="mt-6 space-y-2">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block text-left px-1">Senha do Posto</label>
                    <input 
                      type="password"
                      value={deleteEventPassword}
                      onChange={(e) => {
                        setDeleteEventPassword(e.target.value);
                        setDeleteEventPasswordError(false);
                      }}
                      placeholder="Digite a senha..."
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && deleteEventPassword) {
                          if (deleteEventPassword === adminPassword) {
                            handleDeleteMedicalEvent();
                            setIsDeleteEventConfirmOpen(false);
                            setDeleteEventPassword('');
                            setDeleteEventPasswordError(false);
                          } else {
                            setDeleteEventPasswordError(true);
                          }
                        }
                      }}
                      className={`w-full p-4 bg-slate-50 rounded-2xl border-2 transition-all text-center font-bold focus:ring-0 ${
                        deleteEventPasswordError ? 'border-rose-300 text-rose-500 placeholder:text-rose-300' : 'border-transparent focus:border-indigo-400'
                      }`}
                    />
                    {deleteEventPasswordError && (
                      <p className="text-rose-500 text-[10px] font-bold mt-1">Senha incorreta!</p>
                    )}
                  </div>
                )}
              </div>
              <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => {
                    setIsDeleteEventConfirmOpen(false);
                    setDeleteEventPassword('');
                    setDeleteEventPasswordError(false);
                  }}
                  className="flex-1 py-4 bg-white border border-slate-200 text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={() => {
                    if (medicalEventForm.type === 'medical_request') {
                      if (deleteEventPassword === adminPassword) {
                        handleDeleteMedicalEvent();
                        setIsDeleteEventConfirmOpen(false);
                        setDeleteEventPassword('');
                        setDeleteEventPasswordError(false);
                      } else {
                        setDeleteEventPasswordError(true);
                      }
                    } else {
                      handleDeleteMedicalEvent();
                      setIsDeleteEventConfirmOpen(false);
                    }
                  }}
                  className="flex-1 py-4 bg-rose-500 text-white font-bold rounded-2xl hover:bg-rose-600 shadow-lg shadow-rose-200 transition-all"
                >
                  Excluir
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Notification Delete Confirmation Modal */}
      <AnimatePresence>
        {notifToDelete && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl relative z-10 overflow-hidden flex flex-col"
            >
              <div className="p-8 text-center space-y-4">
                <div className="w-20 h-20 bg-rose-50 rounded-[2rem] flex items-center justify-center mx-auto">
                  <Trash2 className="w-10 h-10 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-slate-900 mb-2">Excluir Lembrete?</h3>
                  <p className="text-slate-500 font-medium text-sm">
                    Você tem certeza que deseja excluir o aviso <strong>"{notifToDelete.title}"</strong>?
                  </p>
                </div>
              </div>
              <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button 
                  onClick={() => setNotifToDelete(null)}
                  className="flex-1 py-4 bg-white border border-slate-200 text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={async () => {
                    try {
                      if (user) {
                        await deleteDoc(doc(db, 'notifications', notifToDelete.id));
                      } else {
                        setNotifications(notifications.filter(n => n.id !== notifToDelete.id));
                      }
                      setNotifToDelete(null);
                    } catch (error) {
                      handleFirestoreError(error, OperationType.DELETE, `notifications/${notifToDelete.id}`);
                    }
                  }}
                  className="flex-1 py-4 bg-rose-500 text-white font-bold rounded-2xl hover:bg-rose-600 shadow-lg shadow-rose-200 transition-all"
                >
                  Excluir
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Vital Signs Modal */}
      <AnimatePresence>
        {isVitalSignsModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsVitalSignsModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 bg-rose-50 border-b border-rose-100 flex items-center justify-between shrink-0 relative">
                <div>
                  <h3 className="text-xl font-bold text-rose-900 leading-tight">Monitoramento de Sinais Vitais</h3>
                  <p className="text-xs font-medium text-rose-600">Registre SpO2, Frequência Cardíaca e Temperatura</p>
                </div>
                <button 
                  onClick={() => setIsVitalSignsModalOpen(false)} 
                  className="absolute top-4 right-4 p-2 hover:bg-rose-200 rounded-full transition-all"
                >
                  <X className="w-5 h-5 text-rose-600" />
                </button>
              </div>

              <div className="p-8 space-y-8 overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Form Section */}
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Quarto</label>
                        <select 
                          value={selectedRoomForVitals}
                          onChange={(e) => {
                            setSelectedRoomForVitals(e.target.value);
                            setVitalSignsForm({ ...vitalSignsForm, childId: '' });
                          }}
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        >
                          <option value="">Todos os quartos</option>
                          {ROOM_OPTIONS.map(room => (
                            <option key={room} value={room}>{room}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Criança</label>
                        <select 
                          value={vitalSignsForm.childId}
                          onChange={(e) => setVitalSignsForm({ ...vitalSignsForm, childId: e.target.value })}
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        >
                          <option value="">{profiles.length === 0 ? 'Carregando crianças...' : 'Selecione a criança...'}</option>
                          {profiles
                            .filter(p => !selectedRoomForVitals || (selectedRoomForVitals === 'Internação Temporária' ? p.id === internedChildId : p.room === selectedRoomForVitals))
                            .map(p => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">SpO2 (%)</label>
                        <input 
                          type="text" 
                          inputMode="numeric"
                          value={vitalSignsForm.spo2}
                          onChange={(e) => setVitalSignsForm({ ...vitalSignsForm, spo2: e.target.value })}
                          placeholder="Ex: 98"
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">FC (BPM)</label>
                        <input 
                          type="text" 
                          inputMode="numeric"
                          value={vitalSignsForm.heartRate}
                          onChange={(e) => setVitalSignsForm({ ...vitalSignsForm, heartRate: e.target.value })}
                          placeholder="Ex: 85"
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Temp. (°C)</label>
                        <input 
                          type="text" 
                          inputMode="decimal"
                          value={vitalSignsForm.temperature}
                          onChange={(e) => setVitalSignsForm({ ...vitalSignsForm, temperature: e.target.value })}
                          placeholder="Ex: 36.5"
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Glicemia (mg/dL)</label>
                        <input 
                          type="number" 
                          inputMode="numeric"
                          value={vitalSignsForm.bloodGlucose}
                          onChange={(e) => {
                            const newGlucose = e.target.value;
                            setVitalSignsForm({ ...vitalSignsForm, bloodGlucose: newGlucose });
                          }}
                          placeholder="Ex: 110"
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        />
                        {vitalSignsForm.bloodGlucose && vitalSignsForm.childId && profiles.find(p => p.id === vitalSignsForm.childId)?.name.toLowerCase().includes('luiza') && (
                          <div className={`mt-2 text-[11px] font-bold p-2 rounded-xl border ${
                            parseFloat(vitalSignsForm.bloodGlucose) < 70 ? 'bg-rose-50 text-rose-600 border-rose-200' : 
                            parseFloat(vitalSignsForm.bloodGlucose) > 200 ? 'bg-amber-50 text-amber-600 border-amber-200' : 
                            'bg-emerald-50 text-emerald-600 border-emerald-200'
                          }`}>
                            {parseFloat(vitalSignsForm.bloodGlucose) < 70 ? '⚠️ ALERTA: Hipoglicemia! Realizar 1 medida de açúcar em 200ml de água.' :
                             parseFloat(vitalSignsForm.bloodGlucose) <= 200 ? '✅ Glicemia controlada. NÃO CORRIGIR.' :
                             parseFloat(vitalSignsForm.bloodGlucose) <= 250 ? '💉 Sugestão: Administrar 1 UI de Insulina REGULAR' :
                             parseFloat(vitalSignsForm.bloodGlucose) <= 300 ? '💉 Sugestão: Administrar 2 UI de Insulina REGULAR' :
                             '🚨 Sugestão: Administrar 3 UI de Insulina REGULAR'}
                          </div>
                        )}
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Insulina (UI)</label>
                        <input 
                          type="number" 
                          inputMode="numeric"
                          value={vitalSignsForm.insulinGiven}
                          onChange={(e) => setVitalSignsForm({ ...vitalSignsForm, insulinGiven: e.target.value })}
                          placeholder="Ex: 2"
                          className="w-full p-3 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-rose-200 text-sm font-medium"
                        />
                      </div>
                    </div>

                    <button 
                      onClick={handleSaveVitalSigns}
                      disabled={isProcessing || !vitalSignsForm.childId}
                      className="w-full py-4 bg-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-rose-100 hover:bg-rose-600 transition-all disabled:opacity-50 active:scale-95"
                    >
                      {isProcessing ? 'Salvando...' : 'Registrar Sinais Vitais'}
                    </button>
                  </div>

                  {/* History Section */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                      <Clock className="w-4 h-4 text-rose-500" /> Histórico Recente
                    </h4>
                    <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                      {vitalSigns
                        .filter(v => !vitalSignsForm.childId || v.childId === vitalSignsForm.childId)
                        .slice(0, 10)
                        .map(reading => (
                          <div key={reading.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                            <div className="flex justify-between items-center">
                              <span className="text-[10px] font-bold text-slate-400 uppercase">{reading.childName}</span>
                              <span className="text-[10px] text-slate-500">{new Date(reading.timestamp).toLocaleString('pt-BR')}</span>
                            </div>
                            <div className="flex gap-4">
                              {reading.spo2 && (
                                <div className="flex flex-col">
                                  <span className="text-[9px] text-slate-400 uppercase font-bold">SpO2</span>
                                  <span className="text-sm font-bold text-rose-600">{reading.spo2}%</span>
                                </div>
                              )}
                              {reading.heartRate && (
                                <div className="flex flex-col">
                                  <span className="text-[9px] text-slate-400 uppercase font-bold">FC</span>
                                  <span className="text-sm font-bold text-rose-600">{reading.heartRate} bpm</span>
                                </div>
                              )}
                              {reading.temperature && (
                                <div className="flex flex-col">
                                  <span className="text-[9px] text-slate-400 uppercase font-bold">Tax</span>
                                  <span className="text-sm font-bold text-rose-600">{reading.temperature}°C</span>
                                </div>
                              )}
                              {reading.bloodGlucose && (
                                <div className="flex flex-col">
                                  <span className="text-[9px] text-slate-400 uppercase font-bold">Glic.</span>
                                  <span className="text-sm font-bold text-rose-600">{reading.bloodGlucose} mg/dL</span>
                                </div>
                              )}
                              {reading.insulinDoseGiven && (
                                <div className="flex flex-col">
                                  <span className="text-[9px] text-slate-400 uppercase font-bold">Insulina</span>
                                  <span className="text-sm font-bold text-rose-600">{reading.insulinDoseGiven} UI</span>
                                </div>
                              )}
                            </div>
                            {reading.authorName && (
                              <div className="pt-2 mt-2 border-t border-slate-100 flex items-center justify-between">
                                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Responsável</span>
                                <span className="text-[10px] font-black text-rose-600/70">{reading.authorName}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      {vitalSigns.filter(v => !vitalSignsForm.childId || v.childId === vitalSignsForm.childId).length === 0 && (
                        <div className="text-center py-8 text-slate-400 text-sm italic">
                          Nenhum registro encontrado.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {fullscreenImage && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4">
            <button 
              onClick={() => setFullscreenImage(null)}
              className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-all"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="relative w-full max-w-5xl h-full flex items-center justify-center" onClick={() => setFullscreenImage(null)}>
              <img 
                src={fullscreenImage} 
                alt="Prescrição em Tela Cheia" 
                className="max-w-full max-h-full object-contain rounded-lg"
                onClick={(e) => e.stopPropagation()} // Prevent click from closing when clicking exactly on the image
              />
            </div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast.show && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[100] bg-slate-800 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 min-w-[300px] border border-slate-700 md:bottom-8"
          >
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            <span className="text-sm font-bold">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isImportantInfoModalOpen && (importantInfoContent || isGeneratingSummary) && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              onClick={() => !isGeneratingSummary && setIsImportantInfoModalOpen(false)}
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-lg rounded-[2.5rem] shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 text-center space-y-6 overflow-y-auto">
                <div className={`w-20 h-20 rounded-[2rem] flex items-center justify-center mx-auto ring-8 shrink-0 ${isGeneratingSummary ? 'bg-sky-50 ring-sky-50/50' : 'bg-amber-50 ring-amber-50/50'}`}>
                  {isGeneratingSummary ? (
                    <Sparkles className="w-10 h-10 text-sky-500 animate-pulse" />
                  ) : (
                    <Sparkles className="w-10 h-10 text-amber-500" />
                  )}
                </div>
                <div className="space-y-2 shrink-0">
                  <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">
                    {isGeneratingSummary ? 'Analisando Enfermaria...' : 'Resumo da Enfermaria'}
                  </h3>
                  <p className="text-slate-500 font-medium text-sm">
                    {isGeneratingSummary ? 'Gerando um resumo inteligente com as informações do último plantão, histórico e atividades recentes.' : 'Resumo inteligente gerado por IA'}
                  </p>
                </div>
                
                <div className={`p-6 rounded-[2rem] text-left shrink-0 transition-all duration-500 ${isGeneratingSummary ? 'bg-slate-50 border border-slate-100 flex items-center justify-center min-h-[150px]' : 'bg-amber-50/50 border border-amber-100/50'}`}>
                  {isGeneratingSummary ? (
                    <div className="flex flex-col items-center gap-3">
                       <Loader2 className="w-6 h-6 text-sky-500 animate-spin" />
                       <span className="text-sm font-bold text-slate-500 animate-pulse">Lendo históricos...</span>
                    </div>
                  ) : (
                    <div className="text-slate-700 font-medium leading-relaxed text-sm format-markdown prose prose-slate max-w-none prose-p:mb-2 prose-p:last:mb-0 prose-ul:mb-2 prose-ul:last:mb-0 prose-li:my-0.5">
                      <Markdown>{importantInfoContent}</Markdown>
                    </div>
                  )}
                </div>

                {!isGeneratingSummary && (
                  <div className="flex items-center justify-center gap-2 group cursor-pointer select-none py-2 shrink-0" 
                       onClick={() => {
                         localStorage.setItem('lastDismissedImportantInfoId', importantInfoId);
                         setIsImportantInfoModalOpen(false);
                       }}>
                    <div className="w-5 h-5 rounded-md border-2 border-slate-200 group-hover:border-amber-400 transition-colors flex items-center justify-center bg-white shadow-sm">
                      <CheckCircle2 className="w-3.5 h-3.5 text-amber-500 scale-0 group-hover:scale-100 transition-transform" />
                    </div>
                    <span className="text-xs font-bold text-slate-400 group-hover:text-amber-500 transition-colors uppercase tracking-widest">Não mostrar novamente hoje</span>
                  </div>
                )}
              </div>
              
              <div className="p-4 border-t border-slate-100 bg-slate-50/50 shrink-0">
                <button 
                  disabled={isGeneratingSummary}
                  onClick={() => setIsImportantInfoModalOpen(false)}
                  className="w-full py-4 bg-slate-800 disabled:bg-slate-300 disabled:text-slate-500 text-white font-black uppercase tracking-widest text-xs rounded-2xl hover:bg-slate-900 transition-all active:scale-95 shadow-lg shadow-slate-200"
                >
                  Entendi, Prosseguir
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  ) : (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 font-sans text-center">
          <Heart className="w-16 h-16 text-rose-500 fill-rose-500 mb-8 mx-auto" />
          <div className="bg-white p-8 rounded-3xl shadow-xl max-w-sm w-full space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-slate-800 tracking-tighter">Bem-vindo ao Portal</h2>
              <p className="text-slate-500 text-sm">Faça login para acessar o sistema do Instituto do Carinho.</p>
            </div>
            
            {loginError && (
              <div className="p-4 bg-rose-50 text-rose-600 rounded-xl text-sm font-medium text-center">
                {loginError}
              </div>
            )}

            <button 
              onClick={handleLogin}
              disabled={isLoggingIn}
              className="w-full py-4 bg-sky-500 text-white font-bold rounded-2xl shadow-lg shadow-sky-100 hover:bg-sky-600 transition-all flex items-center justify-center gap-3 active:scale-95 disabled:opacity-50"
            >
              <Heart className="w-5 h-5 text-white fill-white" />
              {isLoggingIn ? 'Conectando...' : 'Entrar com Google'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
