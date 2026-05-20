export interface ChildActivity {
  id: string;
  childName: string;
  type: 'medication' | 'activity' | 'incident' | 'report' | 'medical_request' | 'medical_completed' | 'glycemia';
  category?: 'alimentacao' | 'intercorrencia' | 'sos' | 'medicacao_rotina' | 'cuidados_extras' | 'rotina';
  description: string;
  timestamp: string;
  appointmentDate?: string;
  appointmentTime?: string;
  status: 'pending' | 'completed' | 'urgent';
  authorUid?: string;
  authorName?: string;
}

export interface ReportSummary {
  title: string;
  summary: string;
  recommendations: string[];
  nextSteps: string[];
}

export interface RecurringMedication {
  id: string;
  name: string;
  times: string[];
  createdAt?: string;
}

export interface DietSchedule {
  id: string;
  description: string;
  times: string[];
}

export interface TemporaryMedication {
  id: string;
  description: string;
  startDate: string;
  endDate: string;
  endTime: string;
  times?: string[];
}

export interface InsulinRule {
  min: number;
  max: number | null; // null means "greater than min"
  dose: number; // UI
}

export interface ChildProfile {
  id: string;
  name: string;
  gender?: 'M' | 'F';
  birthDate: string;
  supportDevices: string[]; // SNE, GTT, TQT, Sem dispositivos
  liquidDiet: string;
  solidDiet: string;
  dietSchedules?: DietSchedule[];
  medicationSchedule: string;
  sosMedications: string;
  temporaryMedications?: TemporaryMedication[];
  currentMedications: string[];
  recurringMedications?: RecurringMedication[];
  specialMedications?: RecurringMedication[];
  insulinProtocol?: {
    enabled: boolean;
    measurementTimes: string[];
    rules: InsulinRule[];
    lowThreshold: number;
    lowInstructions: string;
  };
  extracurriculars: string[];
  preferences: string;
  photoUrl?: string;
  latestPrescriptionImage?: string;
  room?: string;
  weight?: string;
  authorUid?: string;
  createdAt?: any;
  isActive?: boolean;
}

export interface AppNotification {
  id: string;
  activityId?: string;
  title: string;
  description: string;
  date: string;
  startDate?: string;
  endDate?: string;
  time: string;
  type: 'report' | 'medical' | 'activity' | 'other' | 'medication_checkout';
  isRead: boolean;
  isDeleted?: boolean;
  imageUrl?: string;
  authorUid?: string;
  createdAt?: any;
  readBy?: {
    uid: string;
    name: string;
    timestamp: string;
  }[];
}

export interface ChildShiftData {
  childId: string;
  childName: string;
  generalState: string;
  spo2: string;
  fc: string;
  tax: string;
  diuresis: string;
  evacuation: string;
  feeding: string;
  water: string;
  obs: string;
}

export interface ShiftReport {
  id: string;
  date: string;
  room: string;
  house: string;
  staff: string;
  generalInfo?: string;
  importantInfo?: string;
  childrenData: ChildShiftData[];
  createdAt?: any;
  authorUid?: string;
}

export interface VitalSignReading {
  id: string;
  childId: string;
  childName: string;
  spo2?: string;
  heartRate?: string;
  temperature?: string;
  bloodGlucose?: string;
  insulinDoseGiven?: string;
  timestamp: string;
  authorUid: string;
  authorName: string;
}

export interface LegacyReport {
  id: string;
  date: string;
  content: string;
  imageUrl?: string;
  aiAnalysis?: string;
  authorUid: string;
  createdAt: any;
}
