export type Engine = {
  name: string;
  status: 'ACTIVE' | 'COMING SOON';
  image: string;
  icon: 'landslide' | 'glacier' | 'farming' | 'flood';
  active: boolean;
};

export const engines: Engine[] = [
  {
    name: 'Landslide',
    status: 'ACTIVE',
    image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=900&q=88',
    icon: 'landslide',
    active: true,
  },
  {
    name: 'Glacier Collapse',
    status: 'COMING SOON',
    image: 'https://images.unsplash.com/photo-1454496522488-7a8e488e8606?auto=format&fit=crop&w=900&q=88',
    icon: 'glacier',
    active: false,
  },
  {
    name: 'Farming Activities',
    status: 'COMING SOON',
    image: 'https://images.unsplash.com/photo-1530507629858-e4977d30e9e0?auto=format&fit=crop&w=900&q=88',
    icon: 'farming',
    active: false,
  },
  {
    name: 'Flood',
    status: 'COMING SOON',
    image: 'https://images.unsplash.com/photo-1547683905-f686c993aae5?auto=format&fit=crop&w=900&q=85',
    icon: 'flood',
    active: false,
  },
];
