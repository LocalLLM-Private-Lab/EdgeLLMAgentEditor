import { useCallback, useState } from 'react';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import './MenuBar.css';

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Shows a checkmark when true — for toggle-style items (e.g. "is this
   * panel currently shown"). */
  checked?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

export function MenuBar({ menus }: { menus: Menu[] }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  useDismissOnOutsideClick(closeMenu, openMenu !== null);

  return (
    <nav className="menu-bar">
      {menus.map((menu) => (
        <div key={menu.label} className="menu-bar-item">
          <button
            className={`menu-bar-trigger ${openMenu === menu.label ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenu((cur) => (cur === menu.label ? null : menu.label));
            }}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              {menu.items.map((item) => (
                <button
                  key={item.label}
                  className="menu-dropdown-item"
                  disabled={item.disabled}
                  onClick={() => {
                    item.onClick();
                    setOpenMenu(null);
                  }}
                >
                  <span className="menu-dropdown-item-check">{item.checked ? '✓' : ''}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
