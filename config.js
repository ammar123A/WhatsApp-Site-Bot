import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

export default {
  siteGroupName: process.env.SITE_GROUP_NAME || 'SITE MANAGEMENT',
  siteGroupInvite: process.env.SITE_GROUP_INVITE || '',
  adminNumbers: (process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean),
  dateFormat: process.env.DATE_FORMAT || 'DD/MM/YYYY',
  timeFormat: process.env.TIME_FORMAT || 'HH:mm',
  databaseUrl: process.env.DATABASE_URL || '',
  // Origin only - tolerates a pasted https://xxx.supabase.co/rest/v1/
  supabaseUrl: process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  photoBucket: 'site-photos',
  
  // Priority levels for issues
  priorities: {
    LOW: 'low',
    MEDIUM: 'medium', 
    HIGH: 'high',
    URGENT: 'urgent'
  },
  
  // Issue statuses
  issueStatus: {
    OPEN: 'open',
    IN_PROGRESS: 'in_progress',
    RESOLVED: 'resolved',
    CLOSED: 'closed'
  },
  
  // Work categories
  categories: [
    'Civil', 'Structural', 'MEP', 'Architecture', 
    'Interior', 'External', 'Safety', 'Others'
  ],
  
  // Material categories
  materialCategories: [
    'Concrete', 'Steel', 'Timber', 'Bricks', 'Sand', 
    'Aggregate', 'Cement', 'Pipes', 'Electrical', 
    'Plumbing', 'Finishing', 'Others'
  ]
};
